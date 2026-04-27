import { createSystemPrompt, runAgentLoop, runCommand, startRepl, type Message, isMainModule } from "../src/core";

const system = createSystemPrompt("Use bash to solve tasks. Act, don't explain.");
console.log('系统提示词: ', system)
const tools = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  }
];

// ── Mock Agent Loop ──────────────────────────────────────────────────────────
// 无需 API Key，直接根据用户输入伪造模型的 tool_use 决策，验证 bash handler 流程。
// 规则：把用户输入的最后一条消息直接当作 shell 命令执行，然后打印结果。
async function runMockAgentLoop(history: Message[]) {
  const last = history.at(-1);
  const userInput = typeof last?.content === "string" ? last.content : "";

  // Step 1：模拟模型返回 tool_use（bash）
  const fakeToolUseId = "mock_tool_001";
  const assistantMsg: Message = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: fakeToolUseId,
        name: "bash",
        input: { command: userInput }
      }
    ]
  };
  history.push(assistantMsg);
  console.log(`\n[mock] 模型决策 → bash("${userInput}")`);

  // Step 2：真实执行 bash handler
  const result = await runCommand(userInput);
  console.log(`[mock] bash 执行结果:\n${result}`);

  // Step 3：模拟模型读取工具结果后给出最终回复
  history.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: fakeToolUseId, content: result }]
  });
  history.push({
    role: "assistant",
    content: [{ type: "text", text: `命令已执行，结果如上。` }]
  });
}
// ────────────────────────────────────────────────────────────────────────────

export async function runS01(history: Message[]) {
  if (1) {
    await runMockAgentLoop(history);
  } else {
    await runAgentLoop({
      system,
      tools,
      handlers: {
        bash: ({ command }) => runCommand(command)
      },
      messages: history
    });
  }
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s01", runTurn: runS01 });
}
