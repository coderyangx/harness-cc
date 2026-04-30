import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';
import { createOpenAI } from '@ai-sdk/openai';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { JsonValue, Message, ToolHandler, ToolSchema } from './interface';
import {
  autoCompact,
  BackgroundManager,
  baseHandlers,
  baseTools,
  estimateTokens,
  extractText,
  MessageBus,
  microcompact,
  TodoManager,
  transformAnthropicMessages,
  transformOpenaiResponse,
} from './utils';

loadDotenv({ override: true, quiet: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const MODEL = process.env.MODEL_ID ?? 'claude-sonnet-4-6';
export const TOKEN_THRESHOLD = 100_000;
export const POLL_INTERVAL = 5;
export const IDLE_TIMEOUT = 60;
export const VALID_MSG_TYPES = new Set([
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
]);

export const TEAM_DIR = join(WORKDIR, '.team');
export const INBOX_DIR = join(TEAM_DIR, 'inbox');
export const TASKS_DIR = join(WORKDIR, '.tasks');
export const SKILLS_DIR = join(WORKDIR, 'skills');
/** compact dir */
export const TRANSCRIPT_DIR = join(WORKDIR, '.transcripts');

const fridayModelId = 'gpt-5.4-mini'; // 'gpt-4o-mini'
// 必须用 .chat() 明确走 Chat Completions API
// createOpenAI()(modelId) 在新版 AI SDK 中默认走 Responses API，
// 而第三方兼容接口只支持 Chat Completions
const createModel = (options?: { baseURL?: string; apiKey: string }) => {
  if (options?.apiKey) {
    const openaiClient = createOpenAI(options);
    // return openaiClient.chat('z-ai/glm-4.7-flash:free');
    return openaiClient.chat(fridayModelId);
  }
  // return openai(fridayModelId);
};
// const defaultModel = createModel({
//   baseURL: fridayBaseUrl,
//   apiKey: fridayApiKey!,
// });

/** 创建 agent 客户端 */
export function createClient(): OpenAI {
  // OpenAI-compatible mode（当 OPENAI_COMPAT=1 时，使用 OpenAI SDK 走 /v1/chat/completions）
  // if (process.env.OPENAI_COMPAT === '1') {
  return new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
    // codeturbo.ai 对 User-Agent: OpenAI/JS x.x.x 返回 403，
    // 同时无论 stream 与否都返回 Content-Type: text/event-stream，
    // 通过自定义 fetch 同时解决这两个问题。
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('User-Agent', 'node-fetch/1.0');
      const res = await fetch(input, { ...init, headers });
      // 强制改 content-type，让 SDK 按 JSON 解析而非 SSE 流
      const patched = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: new Headers({
          ...Object.fromEntries(res.headers.entries()),
          'content-type': 'application/json',
        }),
      });
      return patched;
    },
  }) as any;
  // }
  // return new Anthropic({
  //   baseURL: process.env.ANTHROPIC_BASE_URL,
  //   apiKey: process.env.ANTHROPIC_API_KEY,
  // });
}

export function createSystemPrompt(instructions: string) {
  return `You are a coding agent at ${WORKDIR}. ${instructions}`;
}

/** 执行 subagent */
export async function runSubagent(prompt: string, agentType = 'Explore') {
  const client = createClient();

  let tools: ToolSchema[] = [...baseTools];
  if (agentType === 'Explore') {
    tools = tools.slice(0, 2);
  }

  const messages: Message[] = [{ role: 'user', content: prompt }];
  let response: any = null;
  for (let i = 0; i < 30; i += 1) {
    // 调用 openai 模型
    if (process.env.OPENAI_COMPAT === '1') {
      response = await (client as OpenAI).chat.completions.create({
        model: MODEL,
        messages,
        tools,
        max_tokens: 8000,
      } as any);
    }
    const choice = response.choices[0];
    response = transformOpenaiResponse(choice);
    // response = await client.messages.create({
    //   model: MODEL,
    //   messages,
    //   tools,
    //   max_tokens: 8000
    // } as any);
    messages.push({ role: 'assistant', content: response.content });
    // 如果不是工具调用，直接退出循环，输出内容
    if (response.stop_reason !== 'tool_use') break;
    const results: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const handler = baseHandlers[block.name];
      const content = handler ? await handler(block.input) : 'Unknown tool';
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: String(content).slice(0, 50_000),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return response ? extractText(response.content) || '(no summary)' : '(subagent failed)';
}

// 执行 AgentLoop
export async function runAgentLoop(options: {
  system: string;
  tools: ToolSchema[];
  handlers: Record<string, ToolHandler>;
  messages: Message[];
  todoManager?: TodoManager;
  backgroundManager?: BackgroundManager;
  messageBus?: MessageBus;
  compressClient?: Anthropic & OpenAI;
}) {
  const client = options.compressClient ?? createClient();
  let roundsWithoutTodo = 0;
  while (true) {
    // 微压缩：把过长的 tool_result 截断
    microcompact(options.messages);
    // console.log('[runAgentLoop] token-cost', estimateTokens(options.messages))
    // token超限时，调模型做摘要，把历史压短
    if (estimateTokens(options.messages) > TOKEN_THRESHOLD) {
      const compacted = await autoCompact(options.messages, client);
      options.messages.splice(0, options.messages.length, ...compacted);
    }
    // console.log('[runAgentLoop] backgroundManager', Boolean(options.backgroundManager))

    if (options.backgroundManager) {
      const notifications = options.backgroundManager.drain();
      if (notifications.length > 0) {
        const text = notifications
          .map((item) => `[bg:${item.task_id}] ${item.status}: ${item.result}`)
          .join('\n');
        options.messages.push({
          role: 'user',
          content: `<background-results>\n${text}\n</background-results>`,
        });
      }
    }
    // console.log('[runAgentLoop] messageBus', Boolean(options.messageBus))
    if (options.messageBus) {
      const inbox = options.messageBus.readInbox('lead');
      if (inbox.length > 0) {
        options.messages.push({
          role: 'user',
          content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
        });
      }
    }
    let response: any;
    // OpenAI-compatible：将 Anthropic 格式消息历史转换为 OpenAI 格式
    // system 必须作为第一条消息，再拼接转换后的历史
    const openaiMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: options.system },
      ...transformAnthropicMessages(options.messages),
    ];
    // 调用 openai 模型
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: openaiMessages,
      tools: options.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
      max_tokens: 8000,
      stream: false,
    });
    const choice = res.choices[0];
    console.log('[runAgentLoop] 模型回复:', {
      ...choice,
      message: {
        ...choice.message,
        tool_calls: JSON.stringify(choice.message.tool_calls),
      },
    });
    // 转换 OpenAI 响应格式为 Anthropic 格式
    response = transformOpenaiResponse(choice);

    // response = await (client as Anthropic).messages.create({
    //   model: MODEL,
    //   system: options.system,
    //   messages: options.messages,
    //   tools: options.tools,
    //   max_tokens: 8000
    // } as any);
    options.messages.push({ role: 'assistant', content: response.content });
    console.log(
      '[runAgentLoop] 全量messages:',
      options.messages.map((m) => ({
        ...m,
        content: JSON.stringify(m.content, null, 4),
      })),
    );
    if (response.stop_reason !== 'tool_use') return response;
    // 保存结果
    const results: JsonValue[] = [];
    let usedTodo = false;
    let manualCompress = false;
    // 处理工具调用结果
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'compress') manualCompress = true;
      const handler = options.handlers[block.name];
      let content: string;
      try {
        content = handler
          ? await handler(block.input as Record<string, any>)
          : `Unknown tool: ${block.name}`;
      } catch (error) {
        content = `Error: ${String(error)}`;
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
      if (block.name === 'TodoWrite' || block.name === 'todo') {
        usedTodo = true;
      }
    }
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (options.todoManager?.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.push({ type: 'text', text: '<reminder>Update your todos.</reminder>' });
    }
    options.messages.push({ role: 'user', content: results });
    console.log('[runAgentLoop] tool-result', {
      role: 'user',
      content: JSON.stringify(results, null, 4),
    });
    // 压缩上下文
    if (manualCompress) {
      const compacted = await autoCompact(options.messages, client);
      options.messages.splice(0, options.messages.length, ...compacted);
      return response;
    }
  }
}
