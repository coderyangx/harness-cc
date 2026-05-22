import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type Document = {
  source: string;
  title: string;
  content: string;
};

export type Chunk = {
  id: string;
  source: string;
  title: string;
  content: string;
  startLine: number;
};

export type EmbeddedChunk = Chunk & {
  embedding: number[];
};

export type SearchResult = EmbeddedChunk & {
  score: number;
};

export type HybridSearchResult = SearchResult & {
  embeddingScore: number;
  keywordScore: number;
};

export type EmbeddingProvider = {
  name: string;
  embed(text: string): Promise<number[]>;
};

export const DOCS_DIR = join(process.cwd(), 'docs', 'pdf');
export const RAG_DIR = join(process.cwd(), '.rag');
export const INDEX_PATH = join(RAG_DIR, 'embeddings.json'); // 保存文件位置
export const CHUNK_SIZE = 900;
export const CHUNK_OVERLAP = 120;
export const FAKE_EMBEDDING_DIM = 256; // 嵌入向量维度

export function loadDocuments(docsDir = DOCS_DIR): Document[] {
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

export function chunkDocument(doc: Document): Chunk[] {
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

export function chunkDocuments(docs: Document[]): Chunk[] {
  return docs.flatMap(chunkDocument);
}

/** local embedding */
export class HashEmbeddingProvider implements EmbeddingProvider {
  name = 'hashing-embedding'; // hash 嵌入

  async embed(text: string): Promise<number[]> {
    const vector = new Array(FAKE_EMBEDDING_DIM).fill(0); // 256 维度
    for (const token of tokenizeForEmbedding(text)) {
      const hash = createHash('sha256').update(token).digest();
      const index = hash.readUInt16BE(0) % FAKE_EMBEDDING_DIM;
      const sign = hash[2] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }
    return normalizeVector(vector);
  }
}

/** openai embedding */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai-compatible-embedding';

  async embed(text: string): Promise<number[]> {
    await ensureWebStreamGlobals();
    const { createClient } = await import('../src/core');
    const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
    const client = createClient();
    // const resp = await client.responses.create({
    //   model: MODEL,
    //   tools: [{ type: 'web_search' }],
    //   input: '2026年五一票房前三的电影',
    // });
    // console.log('response API', resp.output_text);
    const response = await client.embeddings.create({
      model, // 'text-embedding-ada-002' | 'text-embedding-3-small' | 'text-embedding-3-large';
      input: text,
    });
    console.log('[嵌入结果]', response);
    return response.data[0]?.embedding ?? [];
  }
}

/** 获取 queryToken */
export function tokenizeForEmbedding(text: string): string[] {
  const normalized = text.toLowerCase();
  const wordTokens = normalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const cjkTokens = extractCjkNgrams(normalized, 2); // 中文没有空格，增加 bigram 特征

  return [...wordTokens, ...cjkTokens];
}

export function extractCjkNgrams(text: string, n: number): string[] {
  const chars = [...text].filter((char) => /\p{Script=Han}/u.test(char));
  const ngrams: string[] = [];
  for (let i = 0; i <= chars.length - n; i += 1) {
    ngrams.push(chars.slice(i, i + n).join(''));
  }
  return ngrams;
}

export function normalizeVector(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (length === 0) return vector;
  return vector.map((value) => value / length);
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

/** 关键词检索得分 score */
export function scoreKeyword(queryTokens: string[], chunk: Chunk): number {
  const title = chunk.title.toLowerCase(); // 标题匹配
  const source = chunk.source.toLowerCase(); // 文档来源匹配
  const content = chunk.content.toLowerCase(); // 内容匹配

  let score = 0;
  for (const token of queryTokens) {
    if (source.includes(token)) score += 5; // 来源权重较大
    if (title.includes(token)) score += 3; // 文档 title 次之
    const matches = content.match(new RegExp(escapeRegExp(token), 'g')); // 文档内容最小
    score += matches?.length ?? 0;
  }
  return score;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化处理两种得分（避免量纲影响） -> 映射到 [0, 1] 之间 */
export function normalizeScores<T extends { rawScore: number }>(
  items: T[],
): Array<T & { normalized: number }> {
  const scores = items.map((item) => item.rawScore);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;
  if (range === 0) {
    return items.map((item) => ({ ...item, normalized: 0 }));
  }
  return items.map((item) => ({ ...item, normalized: (item.rawScore - minScore) / range }));
}

/** 建索引：把文档分块、向量化、存储 */
export async function buildEmbeddingIndex(provider: EmbeddingProvider): Promise<EmbeddedChunk[]> {
  const docs = loadDocuments();
  const chunks = chunkDocuments(docs); // 分块
  const embedded: EmbeddedChunk[] = [];

  console.log('所有chunks', chunks);

  for (const [index, chunk] of chunks.entries()) {
    // console.log('开始 embedding', index, chunk);
    const embeddingInput = [chunk.title, chunk.source, chunk.content].join('\n');
    embedded.push({
      ...chunk,
      embedding: await provider.embed(embeddingInput), // 向量化
    });
    if ((index + 1) % 20 === 0) {
      console.log(`[index] embedded ${index + 1}/${chunks.length}`);
    }
  }

  mkdirSync(RAG_DIR, { recursive: true });
  writeFileSync(
    INDEX_PATH,
    JSON.stringify(
      {
        provider: provider.name,
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
        createdAt: new Date().toLocaleString(),
        chunks: embedded,
      },
      null,
      2,
    ),
  );
  return embedded;
}

export function loadEmbeddingIndex(): EmbeddedChunk[] {
  if (!existsSync(INDEX_PATH)) {
    throw new Error(`未找到嵌入索引. Run: npx tsx agents/rag_embedding_playground.ts index`);
  }
  const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as { chunks: EmbeddedChunk[] };
  return raw.chunks;
}

/** 向量检索 vectorSearch(query, topK) */
export async function searchByEmbedding(
  query: string,
  chunks: EmbeddedChunk[],
  provider: EmbeddingProvider,
  topK = 5,
): Promise<SearchResult[]> {
  const queryEmbedding = await provider.embed(query); // 向量化 query 参数
  console.log('[输入query向量化]', queryEmbedding);
  return chunks
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding), // 计算相似度
    }))
    .sort((a, b) => b.score - a.score) // 排序
    .slice(0, topK); // 取 topK
}

export async function searchHybrid(
  query: string,
  chunks: EmbeddedChunk[],
  provider: EmbeddingProvider,
  topK = 5,
): Promise<HybridSearchResult[]> {
  const queryEmbedding = await provider.embed(query);
  const queryTokens = tokenizeForEmbedding(query);
  // 语义检索
  const embeddingScores = normalizeScores(
    chunks.map((chunk) => ({
      id: chunk.id,
      rawScore: cosineSimilarity(queryEmbedding, chunk.embedding),
    })),
  );
  // 关键词检索
  const keywordScores = normalizeScores(
    chunks.map((chunk) => ({
      id: chunk.id,
      rawScore: scoreKeyword(queryTokens, chunk),
    })),
  );
  const embeddingById = new Map(embeddingScores.map((item) => [item.id, item.normalized]));
  const keywordById = new Map(keywordScores.map((item) => [item.id, item.normalized]));

  return chunks
    .map((chunk) => {
      const embeddingScore = embeddingById.get(chunk.id) ?? 0;
      const keywordScore = keywordById.get(chunk.id) ?? 0;
      // 计算总得分：关键词 和 语义 权重不同
      const score = embeddingScore * 0.65 + keywordScore * 0.35;
      return {
        ...chunk,
        score,
        embeddingScore,
        keywordScore,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function createProvider(useOpenAI: boolean): EmbeddingProvider {
  const ins = useOpenAI ? new OpenAIEmbeddingProvider() : new HashEmbeddingProvider();
  return ins;
}

export async function ensureWebStreamGlobals() {
  if (typeof globalThis.TransformStream === 'undefined') {
    const webStreams = await import('node:stream/web');
    globalThis.TransformStream = webStreams.TransformStream as typeof globalThis.TransformStream;
  }

  if (
    typeof globalThis.fetch === 'undefined' ||
    typeof globalThis.Headers === 'undefined' ||
    typeof globalThis.Request === 'undefined' ||
    typeof globalThis.Response === 'undefined'
  ) {
    const nodeFetch = await import('node-fetch');
    globalThis.fetch = nodeFetch.default as unknown as typeof globalThis.fetch;
    globalThis.Headers = nodeFetch.Headers as unknown as typeof globalThis.Headers;
    globalThis.Request = nodeFetch.Request as unknown as typeof globalThis.Request;
    globalThis.Response = nodeFetch.Response as unknown as typeof globalThis.Response;
  }
}

// 建索引、查询
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const useOpenAI = args.includes('--1') || process.argv.includes('--1');
  const provider = createProvider(useOpenAI);

  if (command === 'index') {
    console.log('[索引开始]');
    console.log(`[index] provider=${provider.name}`);
    const chunks = await buildEmbeddingIndex(provider);
    console.log(`[index] 写入 ${chunks.length} 嵌入 chunk 到 ${INDEX_PATH}`);
    return;
  }

  // 关键词检索
  if (command === 'search') {
    const query = args.filter((arg) => arg !== '--1').join(' ');
    if (!query) {
      return console.log(
        '使用方法: npx tsx agents/rag_embedding_playground.ts search <query> [--1]',
      );
    }
    const chunks = loadEmbeddingIndex(); // 加载索引，返回完整的 chunks 数组
    const results = await searchByEmbedding(query, chunks, provider, 5); // 检索
    console.log('[search结果]', results);
    console.log('[----------输出检索结果----------]');
    console.log(formatSearchResults(results));
    return;
  }

  // 混合检索
  if (command === 'hybrid') {
    const query = args.filter((arg) => arg !== '--1').join(' ');
    if (!query) {
      return console.log('使用方法: npx tsx agents/s10_rag_embedding.ts hybrid <query> [--1]');
    }
    const chunks = loadEmbeddingIndex();
    const results = await searchHybrid(query, chunks, provider, 5);
    console.log('[----------输出混合检索结果----------]');
    console.log(formatHybridSearchResults(results));
    return;
  }

  // 格式化检索结果
  function formatSearchResults(results: SearchResult[]): string {
    return results
      .map((result, index) => {
        return [
          `[${index + 1}] score=${result.score.toFixed(4)} ${result.title}`,
          `Source: ${result.source}:${result.startLine}`,
          result.content.slice(0, 500),
        ].join('\n');
      })
      .join('\n\n');
  }

  function formatHybridSearchResults(results: HybridSearchResult[]): string {
    return results
      .map((result, index) => {
        return [
          `[${index + 1}] final=${result.score.toFixed(4)} embedding=${result.embeddingScore.toFixed(4)} keyword=${result.keywordScore.toFixed(4)} ${result.title}`,
          `Source: ${result.source}:${result.startLine}`,
          result.content.slice(0, 500),
        ].join('\n');
      })
      .join('\n\n');
  }

  console.log('使用方法:');
  console.log('  npx tsx agents/rag_embedding_playground.ts index [--1]');
  console.log('  npx tsx agents/rag_embedding_playground.ts search <query> [--1]');
  console.log('');
  console.log('注意:');
  console.log('  default uses local hashing embeddings for learning the pipeline');
  console.log('  --1 calls the configured OpenAI-compatible embeddings endpoint');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
