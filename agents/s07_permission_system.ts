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

const todo = new TodoManager();

type PermissionMode = "default" | "plan" | "auto";
type PermissionDecision = "allow" | "deny" | "ask";

interface PermissionRule {
  pattern: string;
  decision: PermissionDecision;
}

class PermissionManager {
  mode: PermissionMode = "default";
  denyRules: PermissionRule[] = [
    { pattern: "rm -rf /", decision: "deny" },
    { pattern: "sudo", decision: "deny" },
    { pattern: "shutdown", decision: "deny" },
    { pattern: "reboot", decision: "deny" }
  ];
  allowRules: PermissionRule[] = [
    { pattern: "ls", decision: "allow" },
    { pattern: "cat", decision: "allow" },
    { pattern: "read_file", decision: "allow" }
  ];
  alwaysAllow: Set<string> = new Set();

  setMode(mode: PermissionMode): string {
    this.mode = mode;
    return `Mode set to: ${mode}`;
  }

  check(toolName: string, input: Record<string, unknown>): PermissionDecision {
    // Check deny rules first
    for (const rule of this.denyRules) {
      if (toolName === "bash" && String(input.command).includes(rule.pattern)) {
        return "deny";
      }
      if (toolName.includes(rule.pattern)) {
        return "deny";
      }
    }

    // Check mode
    if (this.mode === "plan") {
      const writeTools = ["write_file", "edit_file", "bash"];
      if (writeTools.includes(toolName)) {
        return "deny";
      }
    }

    if (this.mode === "auto") {
      const readTools = ["read_file", "bash"];
      if (readTools.includes(toolName)) {
        const bashCmd = toolName === "bash" ? String(input.command) : "";
        if (toolName === "read_file" || bashCmd.startsWith("ls") || bashCmd.startsWith("cat")) {
          return "allow";
        }
      }
    }

    // Check allow rules
    for (const rule of this.allowRules) {
      if (toolName.includes(rule.pattern)) {
        return "allow";
      }
    }

    // Check always-allow set
    const key = `${toolName}:${JSON.stringify(input)}`;
    if (this.alwaysAllow.has(key)) {
      return "allow";
    }

    return "ask";
  }

  addAllow(toolName: string, pattern: string): string {
    this.allowRules.push({ pattern, decision: "allow" });
    return `Added allow rule: ${toolName} / ${pattern}`;
  }

  addDeny(toolName: string, pattern: string): string {
    this.denyRules.push({ pattern, decision: "deny" });
    return `Added deny rule: ${toolName} / ${pattern}`;
  }

  grantAlways(toolName: string, input: Record<string, unknown>): string {
    const key = `${toolName}:${JSON.stringify(input)}`;
    this.alwaysAllow.add(key);
    return `Granted always: ${toolName}`;
  }

  listRules(): string {
    return [
      `Mode: ${this.mode}`,
      `Deny rules: ${this.denyRules.map((r) => r.pattern).join(", ")}`,
      `Allow rules: ${this.allowRules.map((r) => r.pattern).join(", ")}`
    ].join("\n");
  }
}

const permissions = new PermissionManager();
const system = createSystemPrompt(
  "Use tools to solve tasks. All tool calls go through the permission pipeline. Check rules before executing."
);

const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } },
  { name: "permission_mode", description: "Set permission mode.", input_schema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] } },
  { name: "permission_allow", description: "Add allow rule.", input_schema: { type: "object", properties: { tool: { type: "string" }, pattern: { type: "string" } }, required: ["tool", "pattern"] } },
  { name: "permission_deny", description: "Add deny rule.", input_schema: { type: "object", properties: { tool: { type: "string" }, pattern: { type: "string" } }, required: ["tool", "pattern"] } },
  { name: "permission_list", description: "List permission rules.", input_schema: { type: "object", properties: {} } }
];

export async function runS07(history: Message[]) {
  // Wrap handlers with permission check
  const wrapHandler = (name: string, handler: (input: any) => Promise<string> | string) => {
    return async (input: Record<string, unknown>) => {
      const decision = permissions.check(name, input);
      if (decision === "deny") {
        return `Permission denied: ${name}`;
      }
      if (decision === "ask") {
        // In a real implementation, this would prompt the user
        // For now, we auto-grant and remember
        permissions.grantAlways(name, input);
      }
      return handler(input);
    };
  };

  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: wrapHandler("bash", ({ command }) => runCommand(command)),
      read_file: wrapHandler("read_file", ({ path, limit }) => readWorkspaceFile(path, limit)),
      write_file: wrapHandler("write_file", ({ path, content }) => writeWorkspaceFile(path, content)),
      edit_file: wrapHandler("edit_file", ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text)),
      TodoWrite: ({ items }) => todo.update(items),
      permission_mode: ({ mode }) => permissions.setMode(mode as PermissionMode),
      permission_allow: ({ tool, pattern }) => permissions.addAllow(tool, pattern),
      permission_deny: ({ tool, pattern }) => permissions.addDeny(tool, pattern),
      permission_list: () => permissions.listRules()
    },
    messages: history,
    todoManager: todo
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s07", runTurn: runS07 });
}