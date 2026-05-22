import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 原始文档
type Document = {
  source: string; // 文件路径
  title: string; // 文档第一个 # 标题
  content: string; // 全文
};

// 文档片段
type Chunk = {
  id: string;
  source: string;
  title: string;
  content: string;
  startLine: number;
  metadata?: {
    chapterId?: string;
    docType?: string;
    section?: string;
    product?: string;
    version?: string;
    tags?: string[];
    updatedAt?: string;
  };
};

// 检索命中的片段 + 分数
type RetrievedChunk = Chunk & {
  score: number;
};

// 给 prompt 提供上下文的插件接口
type ContextProvider = {
  name: string;
  shouldLoad(query: string): boolean;
  load(query: string): Promise<string>;
};

// 检索器
interface Retriever {
  retrieve(query: string, topK: number): RetrievedChunk[];
}

/**
 * 改 CHUNK_SIZ，从 900 改成 400，再跑一次，观察检索片段变碎
 * 改 query，比如 “skill loading 和 rag 有什么区别”
 * 看 score 为什么某些 chunk 排前面
 * 看 Assembled Prompt，确认 RAG context 是怎么进入模型输入的
 * 最后加 --model，看模型如何基于检索资料回答
 */
const DOCS_DIR = join(process.cwd(), 'docs', 'zh');
const CHUNK_SIZE = 900; // 每个 chunk 最多约 900 字符
const CHUNK_OVERLAP = 120; // 相邻 chunk 重叠约 120 字符
// 为什么要 overlap？
// 因为如果一个关键段落刚好被切在边界，两边都可能缺上下文。重叠可以减少“切断语义”的问题。
const MAX_CHUNKS_PER_SOURCE = 2; // 统一文档最多拿两个 chunk
const RAG_CONTEXT_BUDGET = 3200; // RAG context 最多塞进 prompt 的字符数
// RAG 质量不只取决于 chunk 和模型。
// 用户 query 进入 retriever 之前，通常要经过 query normalization / expansion。
/** 查询同义词 */
const QUERY_SYNONYMS: Record<string, string[]> = {
  上下文: ['context', 'compact', '压缩', 's06'],
  爆掉: ['context', 'compact', '压缩', 's06'],
  太长: ['context', 'compact', '压缩', 's06'],
  压缩: ['context', 'compact', 's06'],
  记忆: ['memory', 's09'],
  长期: ['memory', 's09'],
  提示词: ['system', 'prompt', 's10'],
  系统提示词: ['system', 'prompt', 's10'],
  工具: ['tool', 'use', 's02'],
  技能: ['skill', 'loading', 's05'],
  子任务: ['subagent', 'task', 's04'],
  权限: ['permission', 's07'],
  错误: ['error', 'recovery', 's11'],
  任务系统: ['task', 'system', 's12'],
  后台: ['background', 'tasks', 's13'],
};

function loadDocuments(docsDir = DOCS_DIR): Document[] {
  if (!existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  return readdirSync(docsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const source = join(docsDir, name);
      const content = readFileSync(source, 'utf8');
      const firstHeading = content.split('\n').find((line) => line.startsWith('# '));
      return {
        source,
        title: firstHeading?.replace(/^#\s+/, '').trim() || name,
        content,
      };
    });
}

function chunkDocument(doc: Document): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;

  while (offset < doc.content.length) {
    const end = Math.min(offset + CHUNK_SIZE, doc.content.length);
    const content = doc.content.slice(offset, end).trim();
    if (content) {
      const startLine = doc.content.slice(0, offset).split('\n').length;
      chunks.push({
        id: `${doc.source}#${chunks.length + 1}`,
        source: doc.source,
        title: doc.title,
        content,
        startLine,
      });
    }
    if (end === doc.content.length) break;
    offset = end - CHUNK_OVERLAP;
  }

  return chunks;
}

function chunkDocuments(docs: Document[]): Chunk[] {
  return docs.flatMap(chunkDocument);
}

// 对用户输入 拆词，这里有个重要限制：中文句子没有空格，所以“有什么区别”不会被很好地切出来。当前版本更适合命中：
// 比如："s06 和 s09 有什么区别"  ->  ["s06", "s09"]
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

function expandQueryTokens(query: string, tokens: string[]): string[] {
  console.log('[expandQueryTokens]', query, tokens);
  const expanded = new Set(tokens);

  for (const [keyword, synonyms] of Object.entries(QUERY_SYNONYMS)) {
    if (!query.includes(keyword.toLowerCase())) continue;
    expanded.add(keyword.toLowerCase());
    for (const synonym of synonyms) {
      expanded.add(synonym);
    }
  }

  for (const chapterId of query.match(/s\d{2}/g) ?? []) {
    expanded.add(chapterId);
  }

  return [...expanded];
}

// 根据 query 匹配 chunk，进行打分（打分规则）
function scoreChunk(queryTokens: string[], chunk: Chunk): number {
  // ['s06', '描述了什么']
  const title = chunk.title.toLowerCase();
  const source = chunk.source.toLowerCase();
  const content = chunk.content.toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (source.includes(token)) score += 5; // 文件路径命中：+5
    if (title.includes(token)) score += 3; // 标题命中：+3
    const matches = content.match(new RegExp(escapeRegExp(token), 'g'));
    // 正文每出现一次：+1
    score += matches?.length ?? 0;
  }

  return score;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 关键词检索器 BM25Search(query, topK)
class KeywordRetriever implements Retriever {
  constructor(private chunks: Chunk[]) {}
  /**
   * Retrieval 不是简单拿最高分, 好的 retrieval 要兼顾相关性、覆盖面和上下文预算
   * topK 控制总上下文量；maxPerSource 控制来源多样性；
   * 二者都不是越大越好，而是要和问题类型匹配。
   */
  // 检索：给每个 chunk 打分，丢掉 0 分 chunk，按分数从高到低排序，取前 5 个
  retrieve(query: string, topK = 5): RetrievedChunk[] {
    // 比如："s06 和 s09 有什么区别"  ->  ["s06", "s09", "有什么区别"]
    // const queryTokens = tokenize(query);
    const queryTokens = expandQueryTokens(query, tokenize(query));
    console.log('[retrieve]', 'query', query, 'queryTokens', queryTokens);
    // return this.chunks
    //   .map((chunk) => ({ ...chunk, score: scoreChunk(queryTokens, chunk) }))
    //   .filter((chunk) => chunk.score > 0)
    //   .sort((a, b) => b.score - a.score)
    //   .slice(0, topK); // 根据得分取 topK
    // 从最高分检索 -> 高分检索 + 来源覆盖
    const ranked = this.chunks
      .map((chunk) => ({ ...chunk, score: scoreChunk(queryTokens, chunk) }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score);

    return diversifyBySource(ranked, topK, MAX_CHUNKS_PER_SOURCE);
  }
}

/** 根据文档来源多样化处理 chunk */
function diversifyBySource(
  ranked: RetrievedChunk[],
  topK: number,
  maxPerSource: number,
): RetrievedChunk[] {
  const selected: RetrievedChunk[] = [];
  const countBySource = new Map<string, number>();

  for (const chunk of ranked) {
    const used = countBySource.get(chunk.source) ?? 0;
    if (used >= maxPerSource) continue;

    selected.push(chunk);
    countBySource.set(chunk.source, used + 1);
    if (selected.length >= topK) break;
  }

  return selected;
}

// 接入大模型，harness
class DocsRagProvider implements ContextProvider {
  name = 'docs-rag';
  constructor(private retriever: Retriever) {}

  shouldLoad(query: string): boolean {
    return query.trim().length > 0;
  }

  async load(query: string): Promise<string> {
    const chunks = this.retriever.retrieve(query, 5); // 检索query，返回 chunks
    if (chunks.length === 0) return '未找到相关的课程上下文';
    return chunks
      .map((chunk, index) => {
        return [
          `[${index + 1}] ${chunk.title}`,
          `源-Source: ${chunk.source}:${chunk.startLine}`,
          `得分-Score: ${chunk.score}`,
          chunk.content,
        ].join('\n');
      })
      .join('\n\n---\n\n');
    // return formatChunksWithinBudget(chunks, plan.contextBudget);
  }
}

// 构建系统提示词
function buildPrompt(question: string, ragContext: string): string {
  return [
    '你是 learn-claude-code-ts 的课程问答助手。',
    '只基于 [课程资料] 回答；如果资料不足，就明确说资料不足。',
    '回答时要解释概念边界，并在最后列出你用到的来源编号。',
    '',
    '[-------------课程资料-------------]',
    ragContext,
    '',
    '[-------------用户问题-------------]',
    question,
  ].join('\n');
}

async function callModel(prompt: string): Promise<string> {
  const { createClient, MODEL } = await import('../src/core');
  const client = createClient();
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.choices[0]?.message?.content ?? '(empty model response)';
}

// 提问：s06 描述了什么
// 如果提问：怎么避免模型上下文爆掉？无法找到 s06-context-compact.md，因为它不懂语义
// 语义检索就要依赖 Embedding，embedding 只是替换 KeywordRetrievr，不是推翻整个设计
// keyword search：字面命中
// embedding search：语义接近

async function main() {
  const args = process.argv.slice(2);
  const useModel = args.includes('--model');
  const question = args
    .filter((arg) => arg !== '--model')
    .join(' ')
    .trim();

  if (!question) {
    console.log('Usage: npx tsx agents/rag_playground.ts <question> [--model]');
    console.log('Example: npx tsx agents/rag_playground.ts s06 和 s09 有什么区别');
    return;
  }

  const docs = loadDocuments(); // 加载所有文档
  const chunks = chunkDocuments(docs); // 分块
  const retriever = new KeywordRetriever(chunks); // 检索器
  const rag = new DocsRagProvider(retriever);
  const ragContext = await rag.load(question); // 根据问题，加载rag上下文
  const prompt = buildPrompt(question, ragContext);

  // console.log('\n=== RAG Context ===\n');
  // console.log(ragContext);

  console.log('\n=== Assembled Prompt ===\n');
  console.log(prompt);

  if (!useModel) return console.log('\nTip: 添加 --model 以调用模型');

  console.log('\n=== Model Answer ===\n');
  console.log(await callModel(prompt));
}

await main();
