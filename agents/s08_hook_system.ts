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

// 三个 hook 事件
type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse';

interface Hook {
  event: HookEvent;
  command: string;
  matcher?: string;
}

class HookManager {
  hooks: Hook[] = [];

  constructor() {
    this.loadFromConfig();
  }

  private loadFromConfig() {
    const configPath = join(process.cwd(), '.hooks.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        this.hooks = config.hooks || [];
      } catch {}
    }
  }

  register(event: HookEvent, command: string, matcher?: string): string {
    this.hooks.push({ event, command, matcher });
    return `Registered hook: ${event} -> ${command}`;
  }

  list(): string {
    if (this.hooks.length === 0) return 'No hooks registered.';
    return this.hooks
      .map(
        (h, i) =>
          `${i + 1}. [${h.event}] ${h.command}${h.matcher ? ` (matches: ${h.matcher})` : ''}`,
      )
      .join('\n');
  }

  async runEvent(
    event: HookEvent,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ blocked: boolean; message: string }> {
    const matchingHooks = this.hooks.filter((h) => {
      if (h.event !== event) return false;
      if (!h.matcher) return true;
      return toolName.includes(h.matcher) || String(input).includes(h.matcher);
    });

    for (const hook of matchingHooks) {
      try {
        const result = await runCommand(hook.command);
        // Exit code protocol: 0 = continue, 1 = block, 2 = inject message
        if (result.includes('exit 1') || result.includes('BLOCKED')) {
          return { blocked: true, message: result };
        }
        if (result.includes('exit 2') || result.includes('INJECT')) {
          return { blocked: false, message: result };
        }
      } catch (error) {
        // Hook failed, continue
      }
    }

    return { blocked: false, message: '' };
  }
}

const todo = new TodoManager();
const hooks = new HookManager();
const system = createSystemPrompt(
  'Use tools to solve tasks. Hooks run at lifecycle events: SessionStart, PreToolUse, PostToolUse.',
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
    name: 'hook_register',
    description: 'Register a lifecycle hook.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string' },
        command: { type: 'string' },
        matcher: { type: 'string' },
      },
      required: ['event', 'command'],
    },
  },
  {
    name: 'hook_list',
    description: 'List registered hooks.',
    input_schema: { type: 'object', properties: {} },
  },
];

export async function runS08(history: Message[]) {
  // Run SessionStart hooks once
  await hooks.runEvent('SessionStart', 'session', {});

  // Wrap handlers with PreToolUse and PostToolUse hooks
  const wrapHandler = (name: string, handler: (input: any) => Promise<string> | string) => {
    return async (input: Record<string, unknown>) => {
      const preResult = await hooks.runEvent('PreToolUse', name, input);
      if (preResult.blocked) {
        return `Blocked by hook: ${preResult.message}`;
      }

      const result = await handler(input);

      const postResult = await hooks.runEvent('PostToolUse', name, input);
      if (postResult.message) {
        return result + '\n' + postResult.message;
      }

      return result;
    };
  };

  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: wrapHandler('bash', ({ command }) => runCommand(command)),
      read_file: wrapHandler('read_file', ({ path, limit }) => readWorkspaceFile(path, limit)),
      write_file: wrapHandler('write_file', ({ path, content }) =>
        writeWorkspaceFile(path, content),
      ),
      edit_file: wrapHandler('edit_file', ({ path, old_text, new_text }) =>
        editWorkspaceFile(path, old_text, new_text),
      ),
      TodoWrite: ({ items }) => todo.update(items),
      hook_register: ({ event, command, matcher }) =>
        hooks.register(event as HookEvent, command, matcher),
      hook_list: () => hooks.list(),
    },
    messages: history,
    todoManager: todo,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's08', runTurn: runS08 });
}
