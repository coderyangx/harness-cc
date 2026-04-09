#!/usr/bin/env npx tsx
/**
 * Agent Project Scaffolding Script
 *
 * Usage:
 *   npx tsx init_agent.ts <project-name> [options]
 *
 * Options:
 *   --tools bash,read,write    Specify tools to include
 *   --model claude-sonnet-4-6  Specify model
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_TEMPLATE = {
  "package.json": (name: string) => JSON.stringify({
    name,
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "tsx agent.ts",
      test: "vitest run"
    },
    dependencies: {
      "@anthropic-ai/sdk": "^0.40.1",
      dotenv: "^17.2.3"
    },
    devDependencies: {
      "@types/node": "^24.6.0",
      tsx: "^4.21.0",
      typescript: "^5.9.3",
      vitest: "^3.2.4"
    }
  }, null, 2),

  "tsconfig.json": () => JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"]
    },
    include: ["*.ts"]
  }, null, 2),

  "agent.ts": (name: string) => `import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { spawn } from "node:child_process";

config({ quiet: true });

const client = new Anthropic();
const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const WORKDIR = process.cwd();

const SYSTEM = \`You are a coding agent at \${WORKDIR}.
Use tools to complete tasks. Be concise.\`;

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
  }
];

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
  const fs = await import("node:fs/promises");
  try { return await fs.readFile(path, "utf8"); }
  catch (e) { return \`Error: \${e}\`; }
}

async function writeFile(path: string, content: string): Promise<string> {
  const fs = await import("node:fs/promises");
  try {
    await fs.writeFile(path, content, "utf8");
    return \`Wrote \${content.length} bytes to \${path}\`;
  } catch (e) { return \`Error: \${e}\`; }
}

const messages: any[] = [];
const readline = await import("node:readline/promises");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("${name} Agent Ready. Type 'q' to quit.\\n");

while (true) {
  const input = await rl.question("> ");
  if (input.toLowerCase() === "q") break;
  messages.push({ role: "user", content: input });

  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 4096
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      console.log(response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\\n"));
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
`,

  ".env.example": () => `ANTHROPIC_API_KEY=your-key-here
MODEL_ID=claude-sonnet-4-6
`,

  "README.md": (name: string) => `# ${name}

An AI agent built with Claude.

## Setup

1. Copy \`.env.example\` to \`.env\` and add your API key
2. Run \`npm install\`
3. Run \`npm start\`

## Usage

Type commands to the agent. It will use tools to complete tasks.
`
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith("--")) {
    console.log("Usage: npx tsx init_agent.ts <project-name> [--tools bash,read,write]");
    process.exit(1);
  }

  const projectName = args[0];
  const projectDir = resolve(projectName);

  if (existsSync(projectDir)) {
    console.error(`Directory ${projectName} already exists`);
    process.exit(1);
  }

  mkdirSync(projectDir, { recursive: true });

  for (const [filename, content] of Object.entries(PROJECT_TEMPLATE)) {
    writeFileSync(join(projectDir, filename), content(projectName), "utf8");
    console.log(`Created ${filename}`);
  }

  console.log(`\nAgent project "${projectName}" created!`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${projectName}`);
  console.log(`  npm install`);
  console.log(`  cp .env.example .env && edit .env`);
  console.log(`  npm start`);
}

main().catch(console.error);