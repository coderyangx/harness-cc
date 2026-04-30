import OpenAI from 'openai';
import {
  SkillLoader,
  SKILLS_DIR,
  TodoManager,
  autoCompact,
  createClient,
  createSystemPrompt,
  editWorkspaceFile,
  estimateTokens,
  isMainModule,
  microcompact,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  startRepl,
  TOKEN_THRESHOLD,
  type Message,
  writeWorkspaceFile,
  baseTools,
} from '../src/core';

const skills = new SkillLoader(SKILLS_DIR);
const todo = new TodoManager();
const client = createClient();
const system = createSystemPrompt(
  `Use tools to solve tasks. Manage short plans with TodoWrite, load knowledge with load_skill, and compact context when needed.\nSkills:\n${skills.descriptions()}`,
);

const tools = [
  ...baseTools,
  {
    name: 'TodoWrite',
    description: 'Update task tracking list.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string' },
            },
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'load_skill',
    description: 'Load specialized knowledge by name.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'compress',
    description: 'Manually compress conversation context.',
    input_schema: { type: 'object', properties: {} },
  },
];

export async function runS06(history: Message[]) {
  microcompact(history);
  console.log('[runS06] token-cost', estimateTokens(history), 'THRESHOLD', 70);
  // s06 测试token超限 60
  let compacted_;
  console.log('[runS06] autoCompact before', history);
  if (estimateTokens(history) > 70) {
    const compacted = await autoCompact(history, client);
    compacted_ = compacted;
    history.splice(0, history.length, ...compacted);
  }
  console.log('[runS06] autoCompact after', compacted_);
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      load_skill: ({ name }) => skills.load(name),
      TodoWrite: ({ items }) => todo.update(items),
      compress: () => 'Compressing...',
    },
    messages: history,
    todoManager: todo,
    compressClient: client as any,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's06', runTurn: runS06 });
}
