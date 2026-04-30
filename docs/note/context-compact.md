# Context Compact 上下文压缩工程实践 [s06上下文压缩](https://learn.shareai.run/zh/s06/)

```sh
第 1 层：大结果不直接塞进上下文
-> 写到磁盘，只留预览

第 2 层：旧结果不一直原样保留
-> 替换成简短占位

第 3 层：整体历史太长时
-> 生成一份连续性摘要

tool output
   +-- 太大 -----------------> 保存到磁盘 + 留预览
   v
messages
   +-- 太旧 -----------------> 替换成占位提示
   v
if whole context still too large:
   v
compact history -> summary

```

> 手动触发 `/compact` 或 `compact` 工具，本质上也是走第 3 层。

## 一、为什么需要压缩

大模型的上下文窗口有硬上限（如 claude-4.6 200k token）。在长任务中，消息历史持续累积：

- 每轮 tool_result 可能带回大量文件内容
- 多轮 bash 输出、错误堆栈反复追加
- 多轮对话后，模型记忆不足，超过窗口上限后 API 报错，任务中断

**目标**：在不丢失关键信息的前提下，把历史上下文压短，让任务能继续运行。

---

## 二、压缩什么

这是这章最容易讲虚的地方，压缩不是“把历史缩短”这么简单，**上下文压缩的核心，不是尽量少字，而是让模型在更短的活跃上下文里，仍然保住继续工作的连续性。**
真正重要的是：**让模型还能继续接着干活**
所以一份合格的压缩结果，至少要保住下面这些东西：

- 当前任务目标
- 已完成的关键动作
- 已修改或重点查看过的文件
- 关键决定与约束
- 下一步应该做什么

如果这些没有保住，那压缩虽然腾出了空间，却打断了工作连续性。

```ts
更好的做法是从一开始就有三层思路：
- 大结果先落盘 [persistedOutput -> `<persisted-output>f"Full output saved to: {stored_path}\n"f"Preview:\n{preview}\n"<persisted-output>`]
- 旧结果先缩短 [microCompact -> `[Earlier tool-result has been omitted]`]
- 整体过长再摘要 [summaryCompact -> `"This conversation was compacted for continuity.\n\n" + ${summary}`]
```

切勿把压缩和 memory 混成一类
压缩解决的是：**当前会话太长了怎么办**
memory 解决的是：**哪些信息跨会话仍然值得保留**

## 三、怎么压缩？当前 Demo 实现（[s06](/agents/s06_context_compact.ts)）

### 触发逻辑

```typescript
// 阈值写死（演示用），只在函数入口检查一次
if (estimateTokens(history) > 70) {
  const compacted = await autoCompact(history, client);
  history.splice(0, history.length, ...compacted);
}
```

### 压缩逻辑（autoCompact）

```typescript
// 把全部历史序列化，让模型写一段摘要
const convText = JSON.stringify(messages).slice(-80_000);
const summary = await model('Summarize for continuity:\n' + convText);

// 结果：整个历史 → 一条 user 消息
return [{ role: 'user', content: `[Compressed. Transcript: ${path}]\n${summary}` }];
```

### 微压缩（microcompact）

```typescript
// 把最旧的 tool_result 内容截断为 [cleared]，但保留消息结构
// 只保留最近 3 条 tool_result 的完整内容
for (const part of toolResults.slice(0, -3)) {
  if (part.content.length > 100) part.content = '[cleared]';
}
```

### Demo 的局限

| 问题               | 表现                                    |
| ------------------ | --------------------------------------- |
| 触发时机单一       | 只在入口检查，循环中途超限会直接报错    |
| 全量摘要信息损失大 | Todo 状态、文件路径、错误上下文可能丢失 |
| 注入为 user 消息   | 破坏对话格式，影响模型对角色的理解      |
| 状态靠模型记忆     | 压缩后模型只能靠摘要文字继续，不可靠    |
| 不支持恢复         | transcript 存了磁盘但没有 resume 机制   |

---

## 四、工程级实现策略

### 3.1 动态阈值 + 多级预警

```typescript
const CONTEXT_WINDOW = 200_000; // 模型窗口上限
const COMPACT_THRESHOLD = 0.75; // 75% 时触发压缩
const EMERGENCY_THRESHOLD = 0.9; // 90% 时紧急截断

function shouldCompact(messages: Message[]): 'none' | 'soft' | 'hard' {
  const used = estimateTokens(messages);
  const ratio = used / CONTEXT_WINDOW;
  if (ratio > EMERGENCY_THRESHOLD) return 'hard'; // 紧急：立即截断
  if (ratio > COMPACT_THRESHOLD) return 'soft'; // 正常：摘要压缩
  return 'none';
}
```

每轮 while 循环开头都检查，不只在入口检查一次。

### 3.2 分层压缩策略

```
L1 microcompact   → 截断旧 tool_result 内容为 [cleared]（无损结构，最快）
L2 sliding window → 丢弃最早的 N 条消息，保留最近 K 轮完整对话
L3 summary        → 调模型对历史写结构化摘要，注入 system 消息
L4 pinned state   → 结构化状态（Todo、文件集合）单独持久化，压缩时不丢
```

触发顺序：先 L1，不够再 L2，仍不够才 L3。L4 始终并行维护。

### 3.3 结构化摘要 Prompt（比"Summarize"更精准）

```
你是一个编码助手的上下文压缩器。

当前任务：{task_description}
已完成步骤：{completed_steps}
待完成步骤：{pending_steps}
关键文件：{file_paths}

请生成结构化工作状态摘要，必须包含：
1. 任务目标（一句话）
2. 已完成的具体工作（列表）
3. 下一步要做什么（列表）
4. 重要技术细节（错误信息、文件路径、关键变量名、命令）
5. 当前 Todo 状态

注意：不要省略文件路径和命令，这些是恢复工作的关键。
```

### 3.4 注入 system 消息而非 user 消息

```typescript
// ❌ Demo 做法：注入为 user 消息，破坏对话格式
return [{ role: 'user', content: '[Compressed]\n' + summary }];

// ✅ 工程做法：注入为 system 扩展，不污染对话历史
const newSystem = `${originalSystem}\n\n---\n[Context Summary]\n${summary}`;
// 对话历史从空开始，summary 在 system 中提供连续性
return { system: newSystem, messages: [] };
```

### 3.5 结构化状态持久化

压缩不应该依赖 "模型能从摘要里记住什么"，关键状态要单独写磁盘：

```typescript
interface AgentState {
  todoItems: TodoItem[]; // 当前任务列表
  workingFiles: string[]; // 正在操作的文件路径
  taskGoal: string; // 任务目标
  lastError?: string; // 最后一次错误
  checkpointAt: number; // 压缩时的消息数
}

// 每次压缩前保存
writeFileSync('.agent-state.json', JSON.stringify(state));

// 压缩后恢复注入
const state = JSON.parse(readFileSync('.agent-state.json'));
messages.push({ role: 'user', content: `[State Restored]\n${JSON.stringify(state)}` });
```

Claude Code 把这些存在 `~/.claude/projects/{hash}/` 目录下。

### 3.6 支持 resume

```typescript
// 每次压缩时保存完整 transcript
const transcriptPath = `.transcripts/transcript_${Date.now()}.jsonl`;
writeFileSync(transcriptPath, messages.map(JSON.stringify).join('\n'));

// 支持 --resume 参数恢复
if (process.env.RESUME_FROM) {
  const lines = readFileSync(process.env.RESUME_FROM, 'utf8').split('\n');
  const history = lines.filter(Boolean).map(JSON.parse);
  // 从 transcript 完整还原上下文
}
```

---

## 四、实现对比

| 维度         | Demo（s06）                  | 工程级                                |
| ------------ | ---------------------------- | ------------------------------------- |
| 触发时机     | 入口一次性检查               | 每轮循环检查，动态阈值                |
| 压缩策略     | 单一全量摘要                 | L1~L4 分层（截断→滚动→摘要→持久化）   |
| 摘要 Prompt  | `"Summarize for continuity"` | 结构化 Prompt，强制保留路径/命令      |
| 摘要注入位置 | `user` 消息                  | `system` 消息扩展                     |
| 状态保留     | 靠模型从摘要记忆             | 结构化 JSON 持久化后重新注入          |
| 可恢复性     | transcript 存盘但无 resume   | 完整 transcript + `--resume` 参数恢复 |
| 紧急情况     | 超限直接报错崩溃             | 90% 时强制截断，保证不崩              |

---

## 五、最简可用的工程版实现

在 Demo 基础上，最小改动达到工程可用：

```typescript
const COMPACT_RATIO = 0.75;
const CONTEXT_WINDOW = 128_000; // 按实际模型调整

export async function smartCompact(
  messages: Message[],
  state: AgentState,
  client: OpenAI,
): Promise<Message[]> {
  // L1: 微压缩（总是先做）
  microcompact(messages);

  const tokens = estimateTokens(messages);

  // 未超阈值，直接返回
  if (tokens < CONTEXT_WINDOW * COMPACT_RATIO) return messages;

  // L2: 滑动窗口（保留最近 10 轮）
  if (tokens < CONTEXT_WINDOW * 0.9) {
    return keepRecentRounds(messages, 10);
  }

  // L3: 摘要压缩（超过 90% 时）
  const summary = await summarizeWithState(messages, state, client);

  // 保存 transcript
  saveTranscript(messages);

  // 返回：结构化状态 + 摘要，从头开始对话
  return [{ role: 'user', content: `[State]\n${JSON.stringify(state)}\n\n[Summary]\n${summary}` }];
}
```

---

## 六、参考

- Claude Code 源码：`~/.claude/` 目录结构，`.claude/projects/` 存储 transcript
- Codex：`working_set` 机制，pinned 文件不参与压缩
- OpenClaw：滑动窗口 + 摘要双轨并行，摘要注入 system
