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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const todo = new TodoManager();

class SystemPromptBuilder {
  private cwd = process.cwd();
  private date = new Date().toISOString().split('T')[0];

  private buildCore(): string {
    return 'You are a coding agent. Follow the rules and use tools to solve tasks.';
  }

  private buildToolsSection(): string {
    return 'Tools: bash, read_file, write_file, edit_file, TodoWrite.';
  }

  private buildMemorySection(): string {
    const memoryDir = join(this.cwd, '.memory');
    if (!existsSync(memoryDir)) return '';
    const memories: string[] = [];
    // 读取 MEMORY.md 作为全局记忆摘要（类似 Claude Code 的 ~/.claude/CLAUDE.md）
    try {
      const content = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').trim();
      if (content) memories.push(content);
    } catch {}
    // In a full implementation, we'd load from MemoryManager
    return memories.length > 0 ? `<memory>\n${memories.join('\n')}\n</memory>` : '';
  }

  private buildClaudeMd(): string {
    const claudeMdPath = join(this.cwd, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return '';
    try {
      return readFileSync(claudeMdPath, 'utf8');
    } catch {
      return '';
    }
  }

  private buildDynamic(): string {
    return `<context>
Working directory: ${this.cwd}
Date: ${this.date}
</context>`;
  }

  build(): string {
    const parts = [
      this.buildCore(),
      this.buildToolsSection(),
      this.buildMemorySection(),
      this.buildClaudeMd(),
      this.buildDynamic(),
    ];
    return parts.filter((p) => p).join('\n\n');
  }
}

const promptBuilder = new SystemPromptBuilder();
const system = promptBuilder.build();

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
];

console.log('system', system);
export async function runS10(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      TodoWrite: ({ items }) => todo.update(items),
    },
    messages: history,
    todoManager: todo,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's10', runTurn: runS10 });
}
