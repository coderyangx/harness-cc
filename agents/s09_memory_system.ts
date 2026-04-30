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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const todo = new TodoManager();
const memoryDir = join(process.cwd(), '.memory');
mkdirSync(memoryDir, { recursive: true });

type MemoryType = 'identity' | 'user' | 'feedback' | 'project' | 'preference' | 'reference';

// 身份类文件（无 frontmatter 的原生 Markdown），优先注入 system
const IDENTITY_FILES = ['MEMORY.md']; //  ["SOUL.md", "IDENTITY.md", "USER.md", ];

interface MemoryRecord {
  name: string;
  type: MemoryType;
  description: string;
  content: string;
  created_at: number;
  updated_at: number;
}

class MemoryManager {
  memories: Map<string, MemoryRecord> = new Map();
  // 原生 Markdown 身份文件（直接读取，不做 frontmatter 解析）
  identityDocs: { name: string; content: string }[] = [];

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(join(dir, file), 'utf8').trim();
      if (!text) continue;

      // 无 frontmatter 的原生 Markdown → 作为身份文件处理
      if (IDENTITY_FILES.includes(file) && !text.startsWith('---')) {
        this.identityDocs.push({ name: file.replace('.md', ''), content: text });
        continue;
      }

      // 有 frontmatter → 按原有逻辑解析
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) continue;
      const meta: Record<string, string> = {};
      for (const line of match[1].split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const name = meta.name ?? file.replace('.md', '');
      this.memories.set(name, {
        name,
        type: (meta.type as MemoryType) ?? 'project',
        description: meta.description ?? '',
        content: match[2].trim(),
        created_at: Number(meta.created_at) || Date.now() / 1000,
        updated_at: Number(meta.updated_at) || Date.now() / 1000,
      });
    }
  }

  save(name: string, type: MemoryType, description: string, content: string): string {
    const record: MemoryRecord = {
      name,
      type,
      description,
      content,
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.memories.set(name, record);
    const frontmatter = `---\nname: ${name}\ntype: ${type}\ndescription: ${description}\ncreated_at: ${record.created_at}\nupdated_at: ${record.updated_at}\n---\n`;
    writeFileSync(join(this.dir, `${name}.md`), frontmatter + content, 'utf8');
    return `Saved memory: ${name}`;
  }

  // 更新原生 Markdown 身份文件（模型可直接重写这些文件）
  updateIdentity(name: string, content: string): string {
    const file = `${name}.md`;
    writeFileSync(join(this.dir, file), content, 'utf8');
    const idx = this.identityDocs.findIndex((d) => d.name === name);
    if (idx >= 0) this.identityDocs[idx].content = content;
    else this.identityDocs.push({ name, content });
    return `Updated identity file: ${file}`;
  }

  get(name: string): string {
    const memory = this.memories.get(name);
    if (!memory) return `Unknown memory: ${name}`;
    return JSON.stringify(memory, null, 2);
  }

  list(type?: MemoryType): string {
    const structured = [...this.memories.values()];
    const filtered = type ? structured.filter((m) => m.type === type) : structured;
    const lines: string[] = [];
    if (this.identityDocs.length > 0 && !type) {
      lines.push(...this.identityDocs.map((d) => `[identity] ${d.name}`));
    }
    lines.push(...filtered.map((m) => `[${m.type}] ${m.name}: ${m.description}`));
    return lines.length > 0 ? lines.join('\n') : 'No memories.';
  }

  buildContext(): string {
    const parts: string[] = ['<memory>'];
    // 1. 身份文件优先（SOUL > IDENTITY > USER > 其他）
    const order = ['SOUL', 'IDENTITY', 'USER'];
    const sorted = [
      ...order.map((n) => this.identityDocs.find((d) => d.name === n)).filter(Boolean),
      ...this.identityDocs.filter((d) => !order.includes(d.name)),
    ] as { name: string; content: string }[];
    for (const doc of sorted) {
      parts.push(`\n## ${doc.name}\n\n${doc.content}`);
    }

    // 2. 结构化记忆按类型分组
    const grouped: Record<string, MemoryRecord[]> = {};
    for (const m of this.memories.values()) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push(m);
    }
    for (const [t, items] of Object.entries(grouped)) {
      parts.push(`\n## ${t}`);
      for (const item of items) {
        parts.push(`\n### ${item.name}`);
        parts.push(item.content);
      }
    }

    parts.push('\n</memory>');
    return parts.join('\n');
  }
}

const memory = new MemoryManager(memoryDir);
const system = createSystemPrompt(
  `Use save_memory to remember facts that should persist across sessions. Use list_memory to see what's stored.\n${memory.buildContext()}`,
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
    name: 'save_memory',
    description: 'Save a durable memory record with structured metadata.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'preference', 'reference'] },
        description: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['name', 'type', 'description', 'content'],
    },
  },
  {
    name: 'get_memory',
    description: 'Get a memory record by name.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'list_memory',
    description: 'List all memories.',
    input_schema: { type: 'object', properties: { type: { type: 'string' } } },
  },
  {
    name: 'update_identity',
    description:
      'Update an identity file (SOUL/IDENTITY/USER/MEMORY). Use this to evolve your personality, remember user info, or update your self-description.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['SOUL', 'IDENTITY', 'USER'] },
        content: { type: 'string', description: 'Full new content of the file (Markdown)' },
      },
      required: ['name', 'content'],
    },
  },
];

console.log('runS09---system', system);
export async function runS09(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      TodoWrite: ({ items }) => todo.update(items),
      save_memory: ({ name, type, description, content }) =>
        memory.save(name, type as MemoryType, description, content),
      get_memory: ({ name }) => memory.get(name),
      list_memory: ({ type }) => memory.list(type as MemoryType),
      update_identity: ({ name, content }) => memory.updateIdentity(name, content),
    },
    messages: history,
    todoManager: todo,
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: 's09', runTurn: runS09 });
}
