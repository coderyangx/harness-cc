import {
  SkillLoader,
  SKILLS_DIR,
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

const skills = new SkillLoader(SKILLS_DIR);
const system = createSystemPrompt(
  `Use tools to solve tasks. Load knowledge when needed with load_skill.\nSkills:\n${skills.descriptions()}`,
);
console.log('[skill load] system prompt', system);
const tools = [
  ...baseTools,
  {
    name: 'load_skill',
    description: 'Load specialized knowledge by name.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

export async function runS05(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      load_skill: ({ name }) => skills.load(name),
    },
    messages: history,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's05', runTurn: runS05 });
}
