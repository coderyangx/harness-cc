import {
  TodoManager,
  createSystemPrompt,
  editWorkspaceFile,
  isMainModule,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  startRepl,
  type Message,
  writeWorkspaceFile,
  baseTools,
} from '../src/core';

const todo = new TodoManager();
const system = createSystemPrompt(
  'Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done. Prefer tools over prose.',
);

const tools = [
  ...baseTools,
  {
    name: 'todo',
    description: 'Update task list. Track progress on multi-step tasks.',
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
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['items'],
    },
  },
];

export async function runS03(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      todo: ({ items }) =>
        todo.update(
          items.map((item: any, index: number) => ({
            content: item.text ?? item.content ?? `task-${index + 1}`,
            status: item.status,
            activeForm: item.text ?? item.content ?? `task-${index + 1}`,
          })),
        ),
    },
    messages: history,
    todoManager: todo,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's03', runTurn: runS03 });
}
