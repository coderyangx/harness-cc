import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { appendFileSync, promises as fs, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'path';
import {
  createClient,
  INBOX_DIR,
  MODEL,
  TASKS_DIR,
  TRANSCRIPT_DIR,
  WORKDIR,
} from './reference-agent';
import {
  BackgroundTask,
  Message,
  TaskRecord,
  ToolHandler,
  ToolSchema,
  WorktreeRecord,
} from './interface';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

/**
 * 基础 tool 对应 handler
 */
export const baseHandlers: Record<string, ToolHandler> = {
  bash: ({ command }) => runCommand(command),
  read_file: ({ path }) => readWorkspaceFile(path),
  write_file: ({ path, content }) => writeWorkspaceFile(path, content),
  edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
};

/**
 * 工具列表
 */
export const baseTools: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Run command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit file.',
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

/** Tool 执行 bash 命令 */
export async function runCommand(command: string, commandCwd = WORKDIR, timeoutMs = 120_000) {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some((pattern) => command.includes(pattern))) {
    return 'Error: Dangerous command blocked';
  }

  console.log(`[runCommand] 模型调用 → bash("${command}")`);
  return new Promise<string>((resolvePromise) => {
    const child = spawn(command, {
      cwd: commandCwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolvePromise('Error: Timeout');
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      console.log('stdout-data', chunk);
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(`Error: ${String(error)}`);
      }
    });
    child.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const text = output.trim();
        resolvePromise(text ? text.slice(0, 50_000) : '(no output)');
      }
    });
  });
}

/** Tool 读取文件 */
export async function readWorkspaceFile(path: string, limit?: number) {
  try {
    const content = await fs.readFile(safePath(path), 'utf8');
    const lines = content.split(/\r?\n/);
    if (limit && limit < lines.length) {
      return `${lines.slice(0, limit).join('\n')}\n... (${lines.length - limit} more)`;
    }
    return content.slice(0, 50_000);
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

/** Tool 写入文件 */
export async function writeWorkspaceFile(path: string, content: string) {
  try {
    const fullPath = safePath(path);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    await fs.mkdir(resolve(fullPath, '..'), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

/** Tool 编辑文件 */
export async function editWorkspaceFile(path: string, oldText: string, newText: string) {
  try {
    const fullPath = safePath(path);
    const content = await fs.readFile(fullPath, 'utf8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    await fs.writeFile(fullPath, content.replace(oldText, newText), 'utf8');
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

/** 估计 Token 总花费 */
export function estimateTokens(messages: Message[]) {
  return Math.floor(JSON.stringify(messages).length / 4);
}

/**
 * Tool Todo Planner 管理器
 */
export class TodoManager {
  items: Array<{ content: string; status: string; activeForm: string }> = [];

  update(items: Array<{ content?: string; status?: string; activeForm?: string }>) {
    if (items.length > 20) throw new Error('Max 20 todos');
    let inProgress = 0;
    const normalized = items.map((item, index) => {
      const content = String(item.content ?? '').trim();
      const status = String(item.status ?? 'pending').toLowerCase();
      const activeForm = String(item.activeForm ?? '').trim();
      if (!content) throw new Error(`Item ${index}: content required`);
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Item ${index}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${index}: activeForm required`);
      if (status === 'in_progress') inProgress += 1;
      return { content, status, activeForm };
    });
    if (inProgress > 1) throw new Error('Only one in_progress allowed');
    this.items = normalized;
    return this.render();
  }

  render() {
    if (this.items.length === 0) return 'No todos.';
    const done = this.items.filter((item) => item.status === 'completed').length;
    return [
      ...this.items.map((item) => {
        const marker =
          item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]';
        const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
        return `${marker} ${item.content}${suffix}`;
      }),
      '',
      `(${done}/${this.items.length} completed)`,
    ].join('\n');
  }

  hasOpenItems() {
    return this.items.some((item) => item.status !== 'completed');
  }
}

/* Tool Skill 加载器 */
export class SkillLoader {
  skills = new Map<string, { meta: Record<string, string>; body: string }>();

  constructor(private readonly skillsDir: string) {
    if (!existsSync(skillsDir)) return;
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        if (entry.isFile() && entry.name === 'SKILL.md') {
          const text = readFileSync(full, 'utf8');
          const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          const meta: Record<string, string> = {};
          let body = text;
          if (match) {
            for (const line of match[1].split(/\r?\n/)) {
              const idx = line.indexOf(':');
              if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
            body = match[2].trim();
          }
          const name = meta.name ?? entry.name;
          this.skills.set(name, { meta, body });
        }
      }
    };
    visit(skillsDir);
  }

  descriptions() {
    if (this.skills.size === 0) return '(no skills)';
    return [...this.skills.entries()]
      .map(([name, skill]) => `  - ${name}: ${skill.meta.description ?? '-'}`)
      .join('\n');
  }

  load(name: string) {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(', ')}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

export class TaskManager {
  constructor(private readonly tasksDir = TASKS_DIR) {
    mkdirSync(this.tasksDir, { recursive: true });
  }

  private nextId() {
    const ids = readdirSync(this.tasksDir)
      .filter((name) => /^task_\d+\.json$/.test(name))
      .map((name) => Number(name.match(/\d+/)?.[0] ?? '0'));
    return (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
  }

  private path(taskId: number) {
    return join(this.tasksDir, `task_${taskId}.json`);
  }

  private load(taskId: number): TaskRecord {
    const path = this.path(taskId);
    if (!existsSync(path)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  private save(task: TaskRecord) {
    writeFileSync(this.path(task.id), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  }

  create(subject: string, description = '') {
    const task: TaskRecord = {
      id: this.nextId(),
      subject,
      description,
      status: 'pending',
      owner: null,
      blockedBy: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number) {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  exists(taskId: number) {
    return existsSync(this.path(taskId));
  }

  update(
    taskId: number,
    status?: TaskRecord['status'],
    addBlockedBy?: number[],
    removeBlockedBy?: number[],
  ) {
    const task = this.load(taskId);
    if (status) {
      task.status = status;
      if (status === 'completed') {
        for (const name of readdirSync(this.tasksDir).filter((entry) =>
          /^task_\d+\.json$/.test(entry),
        )) {
          const dependent = JSON.parse(
            readFileSync(join(this.tasksDir, name), 'utf8'),
          ) as TaskRecord;
          dependent.blockedBy = (dependent.blockedBy ?? []).filter((id) => id !== taskId);
          this.save(dependent);
        }
      }
      if (status === 'deleted') {
        if (existsSync(this.path(taskId))) unlinkSync(this.path(taskId));
        return `Task ${taskId} deleted`;
      }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...(task.blockedBy ?? []), ...addBlockedBy])];
    if (removeBlockedBy)
      task.blockedBy = (task.blockedBy ?? []).filter((id) => !removeBlockedBy.includes(id));
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  claim(taskId: number, owner: string) {
    const task = this.load(taskId);
    task.owner = owner;
    task.status = 'in_progress';
    this.save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }

  bindWorktree(taskId: number, worktree: string, owner = '') {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === 'pending') task.status = 'in_progress';
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number) {
    const task = this.load(taskId);
    task.worktree = '';
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    const files = readdirSync(this.tasksDir)
      .filter((name) => /^task_\d+\.json$/.test(name))
      .sort();
    if (files.length === 0) return 'No tasks.';
    return files
      .map((name) => JSON.parse(readFileSync(join(this.tasksDir, name), 'utf8')) as TaskRecord)
      .map((task) => {
        const marker =
          task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[>]' : '[ ]';
        const owner = task.owner ? ` @${task.owner}` : '';
        const blocked =
          task.blockedBy && task.blockedBy.length > 0
            ? ` (blocked by: ${JSON.stringify(task.blockedBy)})`
            : '';
        const worktree = task.worktree ? ` wt=${task.worktree}` : '';
        return `${marker} #${task.id}: ${task.subject}${owner}${blocked}${worktree}`;
      })
      .join('\n');
  }
}

export class BackgroundManager {
  tasks = new Map<string, BackgroundTask>();
  notifications: Array<{ task_id: string; status: string; result: string }> = [];

  run(command: string, timeout = 120) {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: 'running', command, result: null });
    void runCommand(command, WORKDIR, timeout * 1000).then((result) => {
      const status = result.startsWith('Error:') ? 'error' : 'completed';
      this.tasks.set(taskId, { status, command, result });
      this.notifications.push({ task_id: taskId, status, result: result.slice(0, 500) });
    });
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string) {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) return `Unknown: ${taskId}`;
      return `[${task.status}] ${task.result ?? '(running)'}`;
    }
    if (this.tasks.size === 0) return 'No bg tasks.';
    return [...this.tasks.entries()]
      .map(([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`)
      .join('\n');
  }

  drain() {
    const notifications = [...this.notifications];
    this.notifications = [];
    return notifications;
  }
}

export class MessageBus {
  constructor(private readonly inboxDir = INBOX_DIR) {
    mkdirSync(this.inboxDir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType = 'message',
    extra?: Record<string, unknown>,
  ) {
    const payload = JSON.stringify({
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...(extra ?? {}),
    });
    appendFileSync(join(this.inboxDir, `${to}.jsonl`), `${payload}\n`, 'utf8');
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string) {
    const path = join(this.inboxDir, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const messages = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    writeFileSync(path, '', 'utf8');
    return messages;
  }

  broadcast(sender: string, content: string, names: string[]) {
    let count = 0;
    for (const name of names) {
      if (name === sender) continue;
      this.send(sender, name, content, 'broadcast');
      count += 1;
    }
    return `Broadcast to ${count} teammates`;
  }
}

export class EventBus {
  constructor(private readonly logPath: string) {
    mkdirSync(resolve(logPath, '..'), { recursive: true });
    if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8');
  }

  emit(
    event: string,
    task: Record<string, unknown> = {},
    worktree: Record<string, unknown> = {},
    error?: string,
  ) {
    const payload = { event, ts: Date.now() / 1000, task, worktree, ...(error ? { error } : {}) };
    appendFileSync(this.logPath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  listRecent(limit = 20) {
    const lines = readFileSync(this.logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    return JSON.stringify(
      lines.slice(-Math.max(1, Math.min(limit, 200))).map((line) => JSON.parse(line)),
      null,
      2,
    );
  }
}

export function detectRepoRoot(start = WORKDIR) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return null;
    current = parent;
  }
}

export class WorktreeManager {
  dir: string;
  indexPath: string;

  constructor(
    private readonly repoRoot: string,
    private readonly tasks: TaskManager,
    private readonly events: EventBus,
  ) {
    this.dir = join(repoRoot, '.worktrees');
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, 'index.json');
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, `${JSON.stringify({ worktrees: [] }, null, 2)}\n`, 'utf8');
    }
  }

  private loadIndex(): { worktrees: WorktreeRecord[] } {
    return JSON.parse(readFileSync(this.indexPath, 'utf8'));
  }

  private saveIndex(index: { worktrees: WorktreeRecord[] }) {
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  private find(name: string) {
    return this.loadIndex().worktrees.find((entry) => entry.name === name);
  }

  private validateName(name: string) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
      throw new Error('Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -');
    }
  }

  async create(name: string, taskId?: number, baseRef = 'HEAD') {
    this.validateName(name);
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId != null && !this.tasks.exists(taskId)) throw new Error(`Task ${taskId} not found`);
    const path = join(this.dir, name);
    const branch = `wt/${name}`;
    this.events.emit('worktree.create.before', taskId != null ? { id: taskId } : {}, {
      name,
      baseRef,
    });
    const output = await runCommand(
      `git worktree add -b ${branch} ${path} ${baseRef}`,
      this.repoRoot,
    );
    if (output.startsWith('Error:')) {
      this.events.emit(
        'worktree.create.failed',
        taskId != null ? { id: taskId } : {},
        { name, baseRef },
        output,
      );
      throw new Error(output);
    }
    const record: WorktreeRecord = {
      name,
      path,
      branch,
      task_id: taskId,
      status: 'active',
      created_at: Date.now() / 1000,
    };
    const index = this.loadIndex();
    index.worktrees.push(record);
    this.saveIndex(index);
    if (taskId != null) this.tasks.bindWorktree(taskId, name);
    this.events.emit('worktree.create.after', taskId != null ? { id: taskId } : {}, record);
    return JSON.stringify(record, null, 2);
  }

  listAll() {
    const worktrees = this.loadIndex().worktrees;
    if (worktrees.length === 0) return 'No worktrees in index.';
    return worktrees
      .map((worktree) => {
        const suffix = worktree.task_id != null ? ` task=${worktree.task_id}` : '';
        return `[${worktree.status}] ${worktree.name} -> ${worktree.path} (${worktree.branch})${suffix}`;
      })
      .join('\n');
  }

  async status(name: string) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    return runCommand('git status --short --branch', worktree.path, 60_000);
  }

  async run(name: string, command: string) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    return runCommand(command, worktree.path, 300_000);
  }

  async remove(name: string, force = false, completeTask = false) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    this.events.emit(
      'worktree.remove.before',
      worktree.task_id != null ? { id: worktree.task_id } : {},
      { name, path: worktree.path },
    );
    const output = await runCommand(
      `git worktree remove ${force ? '--force ' : ''}${worktree.path}`,
      this.repoRoot,
    );
    if (output.startsWith('Error:')) {
      this.events.emit(
        'worktree.remove.failed',
        worktree.task_id != null ? { id: worktree.task_id } : {},
        { name, path: worktree.path },
        output,
      );
      throw new Error(output);
    }
    if (completeTask && worktree.task_id != null) {
      this.tasks.update(worktree.task_id, 'completed');
      this.tasks.unbindWorktree(worktree.task_id);
      this.events.emit('task.completed', { id: worktree.task_id, status: 'completed' }, { name });
    }
    const index = this.loadIndex();
    for (const entry of index.worktrees) {
      if (entry.name === name) {
        entry.status = 'removed';
        entry.removed_at = Date.now() / 1000;
      }
    }
    this.saveIndex(index);
    this.events.emit(
      'worktree.remove.after',
      worktree.task_id != null ? { id: worktree.task_id } : {},
      { name, path: worktree.path, status: 'removed' },
    );
    return `Removed worktree '${name}'`;
  }

  keep(name: string) {
    const index = this.loadIndex();
    const worktree = index.worktrees.find((entry) => entry.name === name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    worktree.status = 'kept';
    worktree.kept_at = Date.now() / 1000;
    this.saveIndex(index);
    this.events.emit('worktree.keep', worktree.task_id != null ? { id: worktree.task_id } : {}, {
      name,
      path: worktree.path,
      status: 'kept',
    });
    return JSON.stringify(worktree, null, 2);
  }
}

/** 传入完整的 messages，调用模型压缩上下文 */
export async function autoCompact(messages: Message[], client = createClient()) {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  writeFileSync(
    transcriptPath,
    messages.map((message) => JSON.stringify(message)).join('\n'),
    'utf8',
  );
  const convText = JSON.stringify(messages).slice(-80_000);
  // 调用 openai 模型
  const response = await (client as OpenAI).chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: `Summarize for continuity:\n${convText}` }],
    max_tokens: 2000,
  } as any);
  const choice = response.choices[0];
  // const response = await client.messages.create({
  //   model: MODEL,
  //   messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }],
  //   max_tokens: 2000
  // } as any);
  // TODO 只保留 AI 回复内容，忽略 tool-calls
  const summary = choice.message.content;

  return [
    {
      role: 'user' as const,
      content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}`,
    },
  ];
}

/** 微压缩：把旧的工具调用结果做微压缩 显示 [cleared] */
export function microcompact(messages: Message[]) {
  const toolResults: Array<{ content?: unknown }> = [];
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'object' && part !== null && (part as any).type === 'tool_result') {
          toolResults.push(part as any);
        }
      }
    }
  }
  if (toolResults.length <= 3) return;
  for (const part of toolResults.slice(0, -3)) {
    if (typeof part.content === 'string' && part.content.length > 100) {
      part.content = '[cleared]';
    }
  }
}

/** 转换Anthropic消息内容 to OpenAI 格式 */
export const transformAnthropicMessages = (messages: Message[]) => {
  const openaiMessages: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Anthropic assistant: content 是数组，含 text/tool_use block
      // OpenAI assistant: content=null|string, tool_calls=[]
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const textBlocks = blocks.filter((b: any) => b.type === 'text');
      const toolBlocks = blocks.filter((b: any) => b.type === 'tool_use');
      openaiMessages.push({
        role: 'assistant',
        content: textBlocks.length > 0 ? textBlocks.map((b: any) => b.text).join('') : null,
        ...(toolBlocks.length > 0 && {
          tool_calls: toolBlocks.map((b: any) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        }),
      });
    } else if (msg.role === 'user') {
      // Anthropic user: content 可能是字符串或包含 tool_result 的数组
      if (typeof msg.content === 'string') {
        openaiMessages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 将 tool_result block 拆成独立的 tool 角色消息（OpenAI 格式）
        const toolResults = msg.content.filter((b: any) => b.type === 'tool_result');
        const textItems = msg.content.filter((b: any) => b.type !== 'tool_result');
        for (const tr of toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.content ?? '',
          });
        }
        if (textItems.length > 0) {
          openaiMessages.push({
            role: 'user',
            content: textItems.map((b: any) => b.text ?? '').join(''),
          });
        }
      }
    }
  }
  return openaiMessages;
};

/** 转换OpenAI响应格式为Anthropic格式 */
export const transformOpenaiResponse = (choice: OpenAI.ChatCompletion.Choice) => {
  return {
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    content: [
      ...(choice.message.content ? [{ type: 'text', text: choice.message.content }] : []),
      ...(choice.message.tool_calls ?? []).map((tc: any) => {
        console.log('[transformOpenaiResponse - tool_call]', tc.function.name);
        return {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        };
      }),
    ],
  };
};

export function safePath(relativePath: string) {
  const fullPath = resolve(WORKDIR, relativePath);
  if (!fullPath.startsWith(resolve(WORKDIR))) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return fullPath;
}

export function extractText(responseContent: any[]) {
  return responseContent
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
