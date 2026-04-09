import {
  TodoManager,
  autoCompact,
  createClient,
  createSystemPrompt,
  editWorkspaceFile,
  estimateTokens,
  isMainModule,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  startRepl,
  type Message,
  writeWorkspaceFile,
  TOKEN_THRESHOLD
} from "../src/core";

const todo = new TodoManager();
const client = createClient();
const system = createSystemPrompt("Use tools to solve tasks. Handle errors gracefully and retry when appropriate.");

const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } }
];

type RecoveryKind = "continuation" | "compact" | "backoff" | "none";

interface RecoveryState {
  continuationAttempts: number;
  compactAttempts: number;
  transportAttempts: number;
  maxAttempts: number;
}

function chooseRecovery(stopReason: string | null, errorText: string | null): RecoveryKind {
  if (stopReason === "max_tokens") return "continuation";
  if (errorText?.includes("context_length") || errorText?.includes("prompt is too long")) return "compact";
  if (errorText?.includes("timeout") || errorText?.includes("rate limit") || errorText?.includes("connection")) return "backoff";
  return "none";
}

function backoffDelay(attempts: number): number {
  return Math.min(1000 * Math.pow(2, attempts), 30000);
}

export async function runS11(history: Message[]) {
  const recovery: RecoveryState = {
    continuationAttempts: 0,
    compactAttempts: 0,
    transportAttempts: 0,
    maxAttempts: 3
  };

  // Enhanced loop with recovery
  while (true) {
    try {
      // Check if compact needed
      if (estimateTokens(history) > TOKEN_THRESHOLD) {
        if (recovery.compactAttempts < recovery.maxAttempts) {
          recovery.compactAttempts++;
          const compacted = await autoCompact(history, client);
          history.splice(0, history.length, ...compacted);
        }
      }

      await runAgentLoop({
        system,
        tools,
        handlers: {
          bash: ({ command }) => runCommand(command),
          read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
          write_file: ({ path, content }) => writeWorkspaceFile(path, content),
          edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
          TodoWrite: ({ items }) => todo.update(items)
        },
        messages: history,
        todoManager: todo,
        compressClient: client
      });

      // Normal exit
      break;
    } catch (error: any) {
      const errorText = error?.message ?? String(error);
      const recoveryKind = chooseRecovery(null, errorText);

      switch (recoveryKind) {
        case "continuation":
          if (recovery.continuationAttempts < recovery.maxAttempts) {
            recovery.continuationAttempts++;
            history.push({ role: "user", content: "<continuation>Continue from where you left off.</continuation>" });
            continue;
          }
          break;

        case "compact":
          if (recovery.compactAttempts < recovery.maxAttempts) {
            recovery.compactAttempts++;
            const compacted = await autoCompact(history, client);
            history.splice(0, history.length, ...compacted);
            continue;
          }
          break;

        case "backoff":
          if (recovery.transportAttempts < recovery.maxAttempts) {
            recovery.transportAttempts++;
            const delay = backoffDelay(recovery.transportAttempts);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          break;
      }

      // Max retries exceeded or unknown error
      throw error;
    }
  }
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s11", runTurn: runS11 });
}