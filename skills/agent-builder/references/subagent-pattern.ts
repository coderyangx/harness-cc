/**
 * Subagent Pattern - Context isolation for side tasks.
 *
 * Use when:
 * - A task requires exploration that would pollute main context
 * - You need a clean slate for a side investigation
 * - The result is just a summary, not the exploration itself
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";

// Subagent gets limited tools - no spawning children
const SUBAGENT_TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
];

const SUBAGENT_SYSTEM = `You are a focused subagent.
Complete the given task and return ONLY the result.
Do not explain your process. Just do the work and report the outcome.`;

/**
 * Run a subagent with isolated context.
 * Returns only the final text result - all exploration is discarded.
 */
export async function runSubagent(prompt: string, maxTurns = 30): Promise<string> {
  const messages: any[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < maxTurns; i++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages,
      tools: SUBAGENT_TOOLS,
      max_tokens: 4096
    });

    messages.push({ role: "assistant", content: response.content });

    // If done, extract text result
    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      return text || "(no result)";
    }

    // Execute tools
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      let result: string;
      if (block.name === "bash") {
        result = await runBash(block.input.command);
      } else if (block.name === "read_file") {
        result = await runReadFile(block.input.path);
      } else {
        result = "Unknown tool";
      }

      results.push({ type: "tool_result", tool_use_id: block.id, content: result.slice(0, 50000) });
    }

    messages.push({ role: "user", content: results });
  }

  return "(subagent exceeded max turns)";
}

// Tool handlers (same as minimal-agent.ts)
async function runBash(command: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", () => resolve(output.trim() || "(no output)"));
  });
}

async function runReadFile(path: string): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch (e) {
    return `Error: ${e}`;
  }
}

/**
 * Example: Using subagent for isolated exploration
 *
 * In your main agent:
 *
 * ```ts
 * // This would pollute main context with file reads
 * const framework = await runSubagent(
 *   "What testing framework does this project use? Check package.json and config files."
 * );
 *
 * // framework = "vitest" - clean result, no pollution
 * ```
 */