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
  writeWorkspaceFile
} from "../src/core";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const todo = new TodoManager();
const memoryDir = join(process.cwd(), ".memory");
mkdirSync(memoryDir, { recursive: true });

type MemoryType = "user" | "feedback" | "project" | "reference";

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

  constructor(private readonly dir: string) {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const text = readFileSync(join(dir, file), "utf8");
        const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (match) {
          const meta: Record<string, string> = {};
          for (const line of match[1].split(/\r?\n/)) {
            const idx = line.indexOf(":");
            if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
          const name = meta.name ?? file.replace(".md", "");
          this.memories.set(name, {
            name,
            type: (meta.type as MemoryType) ?? "project",
            description: meta.description ?? "",
            content: match[2].trim(),
            created_at: Number(meta.created_at) ?? Date.now() / 1000,
            updated_at: Number(meta.updated_at) ?? Date.now() / 1000
          });
        }
      }
    }
  }

  save(name: string, type: MemoryType, description: string, content: string): string {
    const record: MemoryRecord = {
      name,
      type,
      description,
      content,
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000
    };
    this.memories.set(name, record);
    const frontmatter = `---\nname: ${name}\ntype: ${type}\ndescription: ${description}\ncreated_at: ${record.created_at}\nupdated_at: ${record.updated_at}\n---\n`;
    writeFileSync(join(this.dir, `${name}.md`), frontmatter + content, "utf8");
    return `Saved memory: ${name}`;
  }

  get(name: string): string {
    const memory = this.memories.get(name);
    if (!memory) return `Unknown memory: ${name}`;
    return JSON.stringify(memory, null, 2);
  }

  list(type?: MemoryType): string {
    let memories = [...this.memories.values()];
    if (type) memories = memories.filter((m) => m.type === type);
    if (memories.length === 0) return "No memories.";
    return memories.map((m) => `[${m.type}] ${m.name}: ${m.description}`).join("\n");
  }

  buildContext(): string {
    const memories = [...this.memories.values()];
    if (memories.length === 0) return "";
    const grouped: Record<string, MemoryRecord[]> = {};
    for (const m of memories) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push(m);
    }
    const sections: string[] = ["<memory>"];
    for (const [t, items] of Object.entries(grouped)) {
      sections.push(`\n## ${t}`);
      for (const item of items) {
        sections.push(`\n### ${item.name}`);
        sections.push(item.content);
      }
    }
    sections.push("\n</memory>");
    return sections.join("\n");
  }
}

const memory = new MemoryManager(memoryDir);
const system = createSystemPrompt(
  `Use save_memory to remember facts that should persist across sessions. Use list_memory to see what's stored.\n${memory.buildContext()}`
);

const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } },
  { name: "save_memory", description: "Save a durable memory record.", input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" }, content: { type: "string" } }, required: ["name", "type", "description", "content"] } },
  { name: "get_memory", description: "Get a memory record by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_memory", description: "List all memories.", input_schema: { type: "object", properties: { type: { type: "string" } } } }
];

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
      save_memory: ({ name, type, description, content }) => memory.save(name, type as MemoryType, description, content),
      get_memory: ({ name }) => memory.get(name),
      list_memory: ({ type }) => memory.list(type as MemoryType)
    },
    messages: history,
    todoManager: todo
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s09", runTurn: runS09 });
}