import {
  createSystemPrompt,
  editWorkspaceFile,
  isMainModule,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  runSubagent,
  startRepl,
  type Message,
  writeWorkspaceFile,
  baseTools,
} from '../src/core';

const system = createSystemPrompt(
  'Use tools to solve tasks. Delegate larger investigations with the task tool to keep the parent context clean.',
);

const tools = [
  ...baseTools,
  {
    name: 'task',
    // 派生一个子agent去完成某个任务，隔离上下文
    description: 'Spawn a subagent for isolated exploration or work.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, agent_type: { type: 'string' } },
      required: ['prompt'],
    },
  },
];

export async function runS04(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      task: ({ prompt, agent_type }) => runSubagent(prompt, agent_type),
    },
    messages: history,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's04', runTurn: runS04 });
}
