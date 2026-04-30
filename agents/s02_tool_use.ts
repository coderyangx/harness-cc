import OpenAI from 'openai';
import {
  createSystemPrompt,
  runAgentLoop,
  runCommand,
  readWorkspaceFile,
  writeWorkspaceFile,
  editWorkspaceFile,
  startRepl,
  type Message,
  isMainModule,
} from '../src/core';
import Anthropic from '@anthropic-ai/sdk';

// const instance = new OpenAI({
//   baseURL: 'https://aigc.sankuai.com/v1/openai/native', // 'https://api.ofox.ai/v1/',
//   apiKey: '21902918114338451458', // 'sk-of-jeidkPnfReUsZYYirqNNARgzkQfurAZoXGcyJalCdCwtkfiBZTbjOtuMNkcCVHbi',
// });
// async function testOfox(props) {
//   const { system, tools, handlers, messages } = props;

//   const response = await instance.chat.completions.create({
//     model: 'gpt-4o-mini', // 'z-ai/glm-4.7-flash:free',
//     system,
//     tools,
//     messages: messages?.length > 0 ? messages : [{ role: 'user', content: '告诉我你是谁!' }],
//   });
//   console.log('ai回复----', response.choices[0].message.content);
// }

// const instance = new Anthropic({
//   baseURL: 'https://api.ofox.ai/anthropic',
//   apiKey: 'sk-of-jeidkPnfReUsZYYirqNNARgzkQfurAZoXGcyJalCdCwtkfiBZTbjOtuMNkcCVHbi',
// });
// (async () => {
//   const response = await instance.completions.create({
//     model: "z-ai/glm-4.7-flash:free",
//     prompt: "Hello! Who are you?",
//   });
//   console.log('智谱ai----', response.choices[0]);
// })()

const system = createSystemPrompt("Use tools to solve tasks. Act, don't explain.");
const tools = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
];

export async function runS02(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
    },
    messages: history,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's02', runTurn: runS02 });
}
