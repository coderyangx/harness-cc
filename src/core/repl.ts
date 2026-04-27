import { createInterface } from "readline";
import type { Message } from "./reference-agent";
import { extractText } from "./reference-agent";

export function isMainModule(metaUrl: string) {
  const entry = process.argv[1];
  if (!entry) return false;
  return new URL(metaUrl).pathname === entry;
}

function fn(){
  let n = 5;
  while(1) {
    console.log('while n', n)
    for(let i = 1; i < n; i++) {
      if(i === 3) continue
      console.log('for i', i)
    }
    n--
    if(n === 2) break
  }
}

export async function startRepl(options: {
  sessionId: string;
  runTurn: (history: Message[]) => Promise<void>;
}) {
  const history: Message[] = [];
  process.stdin.setEncoding("utf8");
  while (true) {
    const prompt = await readLine(`\u001b[36m${options.sessionId} >> \u001b[0m`);
    const query = prompt.trim();
    if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") {
      break;
    }
    history.push({ role: "user", content: query });
    await options.runTurn(history);
    const last = history.at(-1);
    if (last && Array.isArray(last.content)) {
      const text = extractText(last.content as any[]);
      if (text) console.log(text);
    }
    console.log();
  }
}

function readLine(prompt: string) {
  return new Promise<string>((resolve) => {
    // 使用 readline 模块，支持退格、方向键、中文输入等行编辑能力
    // process.stdin.once('data') 是 raw 模式，不支持行编辑，会导致退格失效和乱码
    const readline = createReadlineInterface();
    readline.question(prompt, (answer) => {
      readline.close();
      resolve(answer);
    });
  });
}

function createReadlineInterface() {
  // 每次创建新实例（question 后立即 close），确保 resume/pause 状态正确
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true // 开启行编辑：支持退格键、方向键、中文输入
  });
}
