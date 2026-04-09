/**
 * Tool Templates - Capability definitions for agents.
 *
 * Copy these patterns to add new capabilities to your agent.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

// ===== CORE TOOLS =====

/** Bash - Execute shell commands */
export const bashTool = {
  name: "bash",
  description: "Run a shell command. Use for file operations, git, npm, etc.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout: { type: "number", description: "Optional timeout in seconds" }
    },
    required: ["command"]
  }
};

export async function runBash(command: string, timeout = 120): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("Error: Timeout");
    }, timeout * 1000);

    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output.trim().slice(0, 50000) || "(no output)");
    });
  });
}

// ===== FILE TOOLS =====

/** Read file */
export const readFileTool = {
  name: "read_file",
  description: "Read file contents from the workspace.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to file" },
      limit: { type: "number", description: "Max lines to read" }
    },
    required: ["path"]
  }
};

export async function runReadFile(path: string, limit?: number, workdir = process.cwd()): Promise<string> {
  const fs = await import("node:fs/promises");
  const fullPath = resolve(workdir, path);
  try {
    const content = await fs.readFile(fullPath, "utf8");
    const lines = content.split("\n");
    if (limit && limit < lines.length) {
      return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more)`;
    }
    return content.slice(0, 50000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

/** Write file */
export const writeFileTool = {
  name: "write_file",
  description: "Create or overwrite a file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to file" },
      content: { type: "string", description: "Content to write" }
    },
    required: ["path", "content"]
  }
};

export async function runWriteFile(path: string, content: string, workdir = process.cwd()): Promise<string> {
  const fs = await import("node:fs/promises");
  const fullPath = resolve(workdir, path);
  try {
    await fs.mkdir(resolve(fullPath, ".."), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

/** Edit file - replace exact text */
export const editFileTool = {
  name: "edit_file",
  description: "Replace exact text in a file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string", description: "Exact text to find" },
      new_text: { type: "string", description: "Replacement text" }
    },
    required: ["path", "old_text", "new_text"]
  }
};

export async function runEditFile(path: string, oldText: string, newText: string, workdir = process.cwd()): Promise<string> {
  const fs = await import("node:fs/promises");
  const fullPath = resolve(workdir, path);
  try {
    const content = await fs.readFile(fullPath, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    await fs.writeFile(fullPath, content.replace(oldText, newText), "utf8");
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

// ===== SEARCH TOOLS =====

/** Glob search */
export const globTool = {
  name: "glob",
  description: "Find files matching a pattern.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern like **/*.ts" }
    },
    required: ["pattern"]
  }
};

export async function runGlob(pattern: string, workdir = process.cwd()): Promise<string> {
  const { glob } = await import("node:fs/promises");
  try {
    const files: string[] = [];
    for await (const file of glob(pattern, { cwd: workdir })) {
      files.push(file);
    }
    return files.length > 0 ? files.join("\n") : "No matches found";
  } catch (e) {
    return `Error: ${e}`;
  }
}

/** Grep search */
export const grepTool = {
  name: "grep",
  description: "Search file contents.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern" },
      path: { type: "string", description: "Directory or file to search" }
    },
    required: ["pattern"]
  }
};

// ===== HTTP TOOLS =====

/** HTTP GET */
export const httpGetTool = {
  name: "http_get",
  description: "Fetch URL contents.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" }
    },
    required: ["url"]
  }
};

export async function runHttpGet(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    const text = await response.text();
    return text.slice(0, 50000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

// ===== COMBINED TOOL SET =====

export const COMMON_TOOLS = [bashTool, readFileTool, writeFileTool, editFileTool];
export const SEARCH_TOOLS = [globTool, grepTool];
export const HTTP_TOOLS = [httpGetTool];