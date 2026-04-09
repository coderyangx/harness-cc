#!/usr/bin/env npx tsx
/**
 * Minimal Agent Template - Copy and customize this.
 *
 * This is the simplest possible working agent (~80 lines).
 * It has everything you need: 3 tools + loop.
 *
 * Usage:
 *     1. Set ANTHROPIC_API_KEY environment variable
 *     2. npx tsx minimal-agent.ts
 *     3. Type commands, 'q' to quit
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { config } from "dotenv";

config({ override: true, quiet: true });

// Configuration
const client = new Anthropic();
const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const WORKDIR = process.cwd();

// System prompt - keep it simple
const SYSTEM = `You are a coding agent at ${WORKDIR}.

Rules:
- Use tools to complete tasks
- Prefer action over explanation
- Summarize what you did when done`;

// Tool definitions
const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    }
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  }
];

// Tool handlers
async function runBash(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", () => resolve(output.trim() || "(no output)"));
  });
}

async function readFile(path: string): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch (e) {
    return `Error: ${e}`;
  }
}

async function writeFile(path: string, content: string): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, content, "utf8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

// Main loop
async function main() {
  const messages: any[] = [];
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Minimal Agent Ready. Type 'q' to quit.\n");

  while (true) {
    const input = await rl.question("> ");
    if (input.toLowerCase() === "q") break;

    messages.push({ role: "user", content: input });

    while (true) {
      const response = await client.messages.create({
        model: MODEL,
        system: SYSTEM,
        messages,
        tools: TOOLS,
        max_tokens: 4096
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const text = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        console.log(`\n${text}\n`);
        break;
      }

      const results: any[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let result: string;
        if (block.name === "bash") result = await runBash(block.input.command);
        else if (block.name === "read_file") result = await readFile(block.input.path);
        else if (block.name === "write_file") result = await writeFile(block.input.path, block.input.content);
        else result = "Unknown tool";
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      messages.push({ role: "user", content: results });
    }
  }

  rl.close();
}

main().catch(console.error);