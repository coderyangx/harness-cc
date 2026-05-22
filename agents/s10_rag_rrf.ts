/**
 * s10_rag_rrf.ts — 混合检索进阶版（BM25 + RRF）
 *
 * 本文件在 s10_rag_embedding.ts 的基础上，实现了三种更先进的检索策略：
 *
 *  1. searchWeightedHybrid — 加权混合（基准对比）
 *     原理：语义分和关键词分分别 Min-Max 归一化后，按 0.65/0.35 加权求和
 *     问题：归一化受极端值干扰，量纲问题未完全消除
 *
 *  2. searchRrf — RRF 倒数排名融合（推荐）
 *     原理：用排名位置代替原始分数，score = Σ 1/(k + rank)
 *     优点：无量纲问题，对不同来源的分数天然兼容，工业界主流方案
 *
 *  3. searchBm25 — BM25 关键词检索（TF-IDF 升级版）
 *     原理：在 TF-IDF 基础上增加"词频饱和"和"文档长度惩罚"
 *     优点：比简单词频匹配更准确，避免长文档虚高
 *
 * 使用方法（见文件末尾 printUsage）：
 *   npx tsx agents/s10_rag_rrf.ts index           # 建索引（本地 Hash embedding）
 *   npx tsx agents/s10_rag_rrf.ts index --1       # 建索引（真实 OpenAI embedding）
 *   npx tsx agents/s10_rag_rrf.ts rrf <query>     # RRF 混合检索
 *   npx tsx agents/s10_rag_rrf.ts ask <query>     # RAG 问答（检索+生成）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  RAG_DIR,
  chunkDocuments,
  cosineSimilarity,
  createProvider,
  escapeRegExp,
  loadDocuments,
  normalizeScores,
  scoreKeyword,
  tokenizeForEmbedding,
  type Chunk,
  type EmbeddedChunk,
  type EmbeddingProvider,
  type SearchResult,
} from './s10_rag_embedding';

/** 索引文件的磁盘存储格式 */
type StoredIndex = {
  provider: string; // 使用的 embedding 提供商名称
  chunkSize: number; // 分块大小
  chunkOverlap: number; // 分块重叠字符数
  createdAt: string; // 索引创建时间
  chunks: EmbeddedChunk[];
};

/** 加权混合检索结果：包含语义分、关键词分和最终综合分 */
type HybridResult = EmbeddedChunk & {
  score: number; // 最终综合分（加权后）
  embeddingScore: number; // 归一化后的语义分 [0,1]
  keywordScore: number; // 归一化后的关键词分 [0,1]
};

/** RRF 检索结果：包含各路排名和最终 RRF 分 */
type RrfResult = EmbeddedChunk & {
  rrfScore: number; // RRF 综合分（越高越相关）
  embeddingRank: number | null; // 在语义检索中的排名（null 表示未出现）
  keywordRank: number | null; // 在关键词检索中的排名（null 表示未出现）
};

/** BM25 检索结果：包含 BM25 得分 */
type Bm25Result = EmbeddedChunk & {
  bm25Score: number; // BM25 得分（越高越相关）
};

const INDEX_PATH = join(RAG_DIR, 'rrf_embeddings.json');
const DEFAULT_TOP_K = 5; // topK

/**
 * RRF 平滑常数 k
 * 作用：防止排名第1的文档权重过于极端
 * 公式：1/(k + rank)，k=60 时第1名得分约为 0.0164，第10名约为 0.0143，差异适中
 * 通常取 60，来自原始论文 Cormack et al. 2009
 */
const RRF_K = 60;

/**
 * BM25 词频饱和参数 k1
 * 控制词频对得分的影响上限：k1 越大，高词频的加分越多（但有上限）
 * 典型取值 1.2~2.0，这里取 1.5
 */
const BM25_K1 = 1.5;

/**
 * BM25 文档长度惩罚参数 b
 * 控制文档长度对得分的影响：b=1 完全按长度惩罚，b=0 不惩罚
 * 典型取值 0.75，来自 Robertson & Zaragoza 2009
 */
const BM25_B = 0.75;

// ============================================================
// 索引构建与加载
// ============================================================

/**
 * 构建 embedding 索引并写入磁盘
 * 流程：加载文档 → 分块 → 逐块向量化 → 写入 JSON 文件
 */
async function buildRrfEmbeddingIndex(provider: EmbeddingProvider): Promise<EmbeddedChunk[]> {
  const chunks = chunkDocuments(loadDocuments());
  const embedded: EmbeddedChunk[] = [];

  for (const [index, chunk] of chunks.entries()) {
    // 将标题+路径+正文拼接后向量化，让 embedding 包含更多上下文信息
    const embeddingInput = [chunk.title, chunk.source, chunk.content].join('\n');
    embedded.push({
      ...chunk,
      embedding: await provider.embed(embeddingInput),
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
        createdAt: new Date().toISOString(),
        chunks: embedded,
      } satisfies StoredIndex,
      null,
      2,
    ),
  );

  return embedded;
}

/**
 * 从磁盘加载已有索引
 * 会校验 provider 一致性：用 Hash embedding 建的索引不能用真实 embedding 查询
 */
function loadRrfEmbeddingIndex(provider: EmbeddingProvider): EmbeddedChunk[] {
  if (!existsSync(INDEX_PATH)) {
    throw new Error('未找到索引，请先运行: npx tsx agents/s10_rag_rrf.ts index');
  }

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as StoredIndex;
  if (index.provider !== provider.name) {
    throw new Error(
      `索引 provider=${index.provider}，当前 provider=${provider.name}。请用相同 provider 重新 index。`,
    );
  }
  return index.chunks;
}

// ============================================================
// 检索策略一：纯语义检索（Embedding）
// ============================================================

/**
 * 纯语义检索：将 query 向量化后，与所有 chunk 计算余弦相似度，取 topK
 */
async function searchEmbedding(
  query: string,
  chunks: EmbeddedChunk[],
  provider: EmbeddingProvider,
  topK = DEFAULT_TOP_K,
): Promise<SearchResult[]> {
  const queryEmbedding = await provider.embed(query);
  return rankByEmbedding(queryEmbedding, chunks).slice(0, topK);
}

/**
 * 按语义相似度对所有 chunk 排序（不截断，供 RRF 使用完整排名）
 * 余弦相似度范围 [-1, 1]，越接近 1 越相似
 */
function rankByEmbedding(queryEmbedding: number[], chunks: EmbeddedChunk[]): SearchResult[] {
  return chunks
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score);
}

// ============================================================
// 检索策略二：纯关键词检索
// ============================================================

/**
 * 纯关键词检索：对 query 分词后，与 chunk 做词频匹配，取 topK
 */
function searchKeyword(
  query: string,
  chunks: EmbeddedChunk[],
  topK = DEFAULT_TOP_K,
): SearchResult[] {
  console.log('searchKeyword', tokenizeForEmbedding(query));
  return rankByKeyword(tokenizeForEmbedding(query), chunks).slice(0, topK);
}

/**
 * 按关键词得分对所有 chunk 排序（不截断，供 RRF 使用完整排名）
 */
function rankByKeyword(queryTokens: string[], chunks: EmbeddedChunk[]): SearchResult[] {
  return chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreKeyword(queryTokens, chunk),
    }))
    .sort((a, b) => b.score - a.score);
}

// ============================================================
// 检索策略三：加权混合检索（基准对比方案）
// ============================================================
/**
 * 加权混合检索：对语义分和关键词分分别 Min-Max 归一化后，按固定权重融合
 * 公式：finalScore = embeddingScore * 0.65 + keywordScore * 0.35
 *
 * 局限：
 * - Min-Max 归一化受极端值影响（一个异常高分会让其他分数都压缩到接近0）
 * - 权重需要人工调参
 * - 与 RRF 相比稳定性较差
 */
async function searchWeightedHybrid(
  query: string,
  chunks: EmbeddedChunk[],
  provider: EmbeddingProvider,
  topK = DEFAULT_TOP_K,
): Promise<HybridResult[]> {
  const queryEmbedding = await provider.embed(query);
  const queryTokens = tokenizeForEmbedding(query);

  // 各自归一化到 [0, 1]
  const embeddingScores = normalizeScores(
    rankByEmbedding(queryEmbedding, chunks).map((result) => ({
      id: result.id,
      rawScore: result.score,
    })),
  );
  const keywordScores = normalizeScores(
    rankByKeyword(queryTokens, chunks).map((result) => ({
      id: result.id,
      rawScore: result.score,
    })),
  );

  // 建立  id → 归一化分  的快查 Map
  const embeddingById = new Map(embeddingScores.map((item) => [item.id, item.normalized]));
  const keywordById = new Map(keywordScores.map((item) => [item.id, item.normalized]));

  return chunks
    .map((chunk) => {
      const embeddingScore = embeddingById.get(chunk.id) ?? 0;
      const keywordScore = keywordById.get(chunk.id) ?? 0;
      return {
        ...chunk,
        score: embeddingScore * 0.65 + keywordScore * 0.35, // 加权融合
        embeddingScore,
        keywordScore,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ============================================================
// 检索策略四：RRF 倒数排名融合（推荐方案）
// ============================================================
/**
 * RRF 混合检索（Reciprocal Rank Fusion）
 *
 * 核心思想：不关心原始分数，只关心"排名位置"，用排名的倒数来融合多路结果
 * 公式：rrfScore = 1/(k + embeddingRank) + 1/(k + keywordRank)
 *   - k=60 是平滑常数，防止第1名权重过于极端
 *   - 排名 null（未出现在该路结果中）贡献 0 分
 *
 * 优点：
 *   - 无量纲问题，天然解决 "语义分 vs 关键词分" 无法直接相加的问题
 *   - 不需要归一化，不受极端值影响
 *   - 不需要手动调权重
 */
async function searchRrf(
  query: string,
  chunks: EmbeddedChunk[],
  provider: EmbeddingProvider,
  topK = DEFAULT_TOP_K,
): Promise<RrfResult[]> {
  const queryEmbedding = await provider.embed(query);
  const queryTokens = tokenizeForEmbedding(query);

  // 获取两路的完整排名（不截断）
  const embeddingRankById = buildRankMap(rankByEmbedding(queryEmbedding, chunks));
  const keywordRankById = buildRankMap(rankByKeyword(queryTokens, chunks));

  return chunks
    .map((chunk) => {
      const embeddingRank = embeddingRankById.get(chunk.id) ?? null;
      const keywordRank = keywordRankById.get(chunk.id) ?? null;
      // 倒数排名求和：排名越靠前，贡献的分数越大
      const rrfScore =
        (embeddingRank === null ? 0 : 1 / (RRF_K + embeddingRank)) +
        (keywordRank === null ? 0 : 1 / (RRF_K + keywordRank));
      return {
        ...chunk,
        rrfScore,
        embeddingRank,
        keywordRank,
      };
    })
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}

/**
 * 将有序检索结果列表转换为 id → 排名 的 Map
 * 例：[chunkA, chunkB, chunkC] → { chunkA: 1, chunkB: 2, chunkC: 3 }
 */
function buildRankMap(results: SearchResult[]): Map<string, number> {
  return new Map(results.map((result, index) => [result.id, index + 1]));
}

// ============================================================
// 检索策略五：BM25 关键词检索（TF-IDF 升级版）
// ============================================================
/**
 * BM25 关键词检索
 * 相比简单词频匹配的优势：
 *   1. TF 饱和：词出现多次不会无限加分，避免"堆词"得高分
 *   2. 文档长度惩罚：长文档因词多天然有优势，BM25 对此补偿
 */
function searchBm25(query: string, chunks: EmbeddedChunk[], topK = DEFAULT_TOP_K): Bm25Result[] {
  const queryTokens = tokenizeForEmbedding(query);
  // 预先计算语料统计信息（文档频率、平均文档长度）
  const stats = buildBm25Stats(chunks);
  console.log('searchBm25', queryTokens, '\n', stats);
  return chunks
    .map((chunk) => ({
      ...chunk,
      bm25Score: scoreBm25(queryTokens, chunk, stats),
    }))
    .sort((a, b) => b.bm25Score - a.bm25Score)
    .slice(0, topK);
}

/**
 * 预计算 BM25 所需的全局统计信息
 *
 * @returns documentFrequency - 每个词出现在多少个文档中（DF）
 * @returns documentCount     - 文档总数（N）
 * @returns averageLength     - 所有文档的平均 token 数（avgdl）
 */
function buildBm25Stats(chunks: Chunk[]) {
  const documents = chunks.map((chunk) => tokenizeForEmbedding(chunk.content));
  const documentFrequency = new Map<string, number>();

  for (const tokens of documents) {
    // 每个词在同一文档里只计一次（用 Set 去重）
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  return {
    documentFrequency,
    documentCount: documents.length,
    // 平均文档长度（token 数），用于长度惩罚的归一化
    averageLength:
      documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(documents.length, 1),
  };
}

/**
 * 计算单个 chunk 的 BM25 得分
 *
 * BM25 公式（对每个查询词求和）：
 *   score += IDF(t) × [TF(t,d) × (k1+1)] / [TF(t,d) + k1×(1 - b + b×|d|/avgdl)]
 *
 * 其中：
 *   IDF(t) = log(1 + (N - df + 0.5) / (df + 0.5))  — 逆文档频率
 *   TF(t,d) = 词 t 在文档 d 中出现的次数
 *   |d| = 文档 d 的 token 数
 *   avgdl = 语料平均文档长度
 *   k1, b = 超参数（见常量配置）
 */
function scoreBm25(
  queryTokens: string[],
  chunk: Chunk,
  stats: ReturnType<typeof buildBm25Stats>,
): number {
  const tokens = tokenizeForEmbedding(chunk.content);

  // 统计当前文档中每个词的词频 TF
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const token of queryTokens) {
    const tf = frequencies.get(token) ?? 0;
    if (tf === 0) continue; // 文档中不含此词，跳过

    const df = stats.documentFrequency.get(token) ?? 0;
    // IDF：词越稀有（df越小），IDF越大，对得分贡献越大
    const idf = Math.log(1 + (stats.documentCount - df + 0.5) / (df + 0.5));
    // 分母包含长度惩罚：文档越长于平均值，得分折扣越大（b 控制惩罚强度）
    const denominator =
      tf + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / stats.averageLength));
    score += idf * ((tf * (BM25_K1 + 1)) / denominator);
  }

  return score;
}

// ============================================================
// RAG 问答：检索 + 生成
// ============================================================

/**
 * 完整 RAG 流程：使用 RRF 检索相关文档片段，拼接为 prompt，调用模型生成答案
 *
 * 降级策略：模型调用失败时返回拼接好的 prompt 预览，方便调试
 */
async function answerWithRag(
  query: string,
  chunks: EmbeddedChunk[],
  provider: EmbeddingProvider,
): Promise<string> {
  // Step 1: 检索最相关的 topK 个 chunk
  const results = await searchRrf(query, chunks, provider, DEFAULT_TOP_K);

  // Step 2: 将检索结果拼接为上下文 prompt
  const prompt = [
    '你是 RAG 学习助手。请只基于 [资料] 回答问题。',
    '如果资料不足，请明确说资料不足，不要编造。',
    '回答最后列出使用的来源编号。',
    '',
    '[资料]',
    formatContext(results),
    '',
    '[问题]',
    query,
  ].join('\n');

  console.log('[System Context]', prompt);

  // Step 3: 调用模型生成答案
  try {
    const { createClient, MODEL } = await import('../src/core');
    const client = createClient();
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.choices[0]?.message?.content ?? '(empty model response)';
  } catch (error) {
    // 模型不可用时，降级返回 prompt 预览（便于调试检索质量）
    return [
      '[模型调用失败，已降级为 prompt 预览]',
      error instanceof Error ? error.message : String(error),
      '',
      prompt,
    ].join('\n');
  }
}

// ============================================================
// 结果格式化输出
// ============================================================

/** 格式化普通带分数的检索结果（用于 embedding/keyword 命令） */
function formatScoredResults(results: SearchResult[], label = 'score'): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] ${label}=${result.score.toFixed(4)} ${result.title}`,
        `Source: ${result.source}:${result.startLine}`,
        result.content.slice(0, 500),
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

/** 格式化加权混合检索结果（同时展示语义分、关键词分和综合分） */
function formatHybridResults(results: HybridResult[]): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] final=${result.score.toFixed(4)} embedding=${result.embeddingScore.toFixed(4)} keyword=${result.keywordScore.toFixed(4)} ${result.title}`,
        `Source: ${result.source}:${result.startLine}`,
        result.content.slice(0, 500),
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

/** 格式化 RRF 检索结果（展示 RRF 分和各路排名，便于分析） */
function formatRrfResults(results: RrfResult[]): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] rrfScore=${result.rrfScore.toFixed(5)} embeddingRank=${result.embeddingRank ?? '-'} keywordRank=${result.keywordRank ?? '-'} ${result.title}`,
        `Source: ${result.source}:${result.startLine}`,
        result.content.slice(0, 500),
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

/** 格式化 BM25 检索结果 */
function formatBm25Results(results: Bm25Result[]): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] bm25Score=${result.bm25Score.toFixed(4)} ${result.title}`,
        `Source: ${result.source}:${result.startLine}`,
        result.content.slice(0, 500),
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

/** 格式化 RAG 问答的上下文（去掉分数，只保留内容，发给模型） */
function formatContext(results: RrfResult[]): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.title}`,
        `Source: ${result.source}:${result.startLine}`,
        result.content.slice(0, 1200),
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

// ============================================================
// 命令行入口
// npx tsx agents/s10_rag_rrf.ts index
// npx tsx agents/s10_rag_rrf.ts rrf "RRF 是怎么合并搜索结果的"
// npx tsx agents/s10_rag_rrf.ts bm25 "TF IDF 文档长度归一化"
// npx tsx agents/s10_rag_rrf.ts hybrid "混合搜索如何结合关键字和语义搜索"
// ============================================================

async function main() {
  const [command, ...args] = process.argv.slice(2);
  // --1 参数：使用真实 OpenAI embedding（需配置 EMBEDDING_BASE_URL/EMBEDDING_API_KEY）
  // 默认：使用本地 Hash embedding（无需 API Key，适合学习流程）
  const useOpenAI = args.includes('--1') || process.argv.includes('--1');
  const provider = createProvider(useOpenAI);

  if (command === 'index') {
    console.log(`[index] provider=${provider.name}`);
    const chunks = await buildRrfEmbeddingIndex(provider);
    console.log(`[index] wrote ${chunks.length} embedded chunks to ${INDEX_PATH}`);
    return;
  }
  const query = args
    .filter((arg) => arg !== '--1')
    .join(' ')
    .trim();
  if (!command || !query) {
    printUsage();
    return;
  }

  const chunks = loadRrfEmbeddingIndex(provider); // chunk 块 (已 embedding)
  if (command === 'embedding') {
    // 纯语义检索
    console.log(
      formatScoredResults(await searchEmbedding(query, chunks, provider), 'embeddingScore'),
    );
    return;
  }
  if (command === 'keyword') {
    // 纯关键词检索（简单词频）
    console.log(formatScoredResults(searchKeyword(query, chunks), 'keywordScore'));
    return;
  }
  if (command === 'hybrid') {
    // 加权混合检索（基准对比）
    console.log(formatHybridResults(await searchWeightedHybrid(query, chunks, provider)));
    return;
  }
  if (command === 'rrf') {
    // RRF 混合检索（推荐）
    console.log(formatRrfResults(await searchRrf(query, chunks, provider)));
    return;
  }
  if (command === 'bm25') {
    // BM25 关键词检索（TF-IDF 升级版）
    console.log(formatBm25Results(searchBm25(query, chunks)));
    return;
  }
  if (command === 'ask') {
    // RAG 完整问答流程（RRF 检索 + 模型生成）
    console.log(await answerWithRag(query, chunks, provider));
    return;
  }

  printUsage();
}

function printUsage() {
  console.log('Usage:');
  console.log('  npx tsx agents/s10_rag_rrf.ts index [--1]        # 建索引');
  console.log('  npx tsx agents/s10_rag_rrf.ts embedding <query> [--1]  # 纯语义检索');
  console.log('  npx tsx agents/s10_rag_rrf.ts keyword <query>    # 纯关键词检索');
  console.log('  npx tsx agents/s10_rag_rrf.ts hybrid <query> [--1]    # 加权混合检索');
  console.log('  npx tsx agents/s10_rag_rrf.ts rrf <query> [--1]       # RRF 混合检索（推荐）');
  console.log('  npx tsx agents/s10_rag_rrf.ts bm25 <query>       # BM25 关键词检索');
  console.log('  npx tsx agents/s10_rag_rrf.ts ask <query> [--1]       # RAG 问答');
}

await main();
