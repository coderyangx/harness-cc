## 系统架构

RAG 系统的核心流程是：将文档切分成段落 chunk → 向量化 vector → 存储 embedding → 检索 query

### PDF 解析与切块

负责将 PDF 文件转化为可检索的文本块。

```ts
核心函数：
  extractPdfPages(pdfPath)  → PageText[]
  splitIntoChunks(text)     → string[]
  buildChunks(pages, path)  → Chunk[]

切块策略（滑动窗口）：
  文本: "ABCDEFGHIJ..."
  chunk_size=500, overlap=50
  块1: [0   ~ 500]
  块2: [450 ~ 950]   ← 从 500-50=450 开始
  块3: [900 ~ 1400]  ← 从 950-50=900 开始
  overlap 的作用：防止跨块边界的关键信息被截断

Chunk ID 生成：
  Base64URL(source::pPage::cIdx::text前40字符)
  → 同一文档内容唯一，支持增量索引去重

```

### 本地向量化

使用 `@xenova/transformers` 在 Node.js 中本地运行 Transformer 模型。

```ts
模型：paraphrase-multilingual-MiniLM-L12-v2
  - 向量维度：384
  - 支持语言：50+ 种（含中文）
  - 模型大小：~120MB（首次自动下载，之后缓存）
  - 推理速度：CPU 下约 50ms/条

Pooling 策略：mean pooling + L2 归一化
  → 得到语义稳定的句向量，适合余弦相似度计算

懒加载设计：
  pipeline 变量在模块级别缓存
  → 同一进程内只初始化一次，避免重复加载模型
```

### 整合上层模块，实现完整的索引和问答流程。同时负责 Vercel AI SDK 的调用

```ts
Vercel AI SDK 用法：
  import { generateText } from 'ai';
  import { createOpenAI } from '@ai-sdk/openai';
  const openai = createOpenAI({ apiKey, baseURL });
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    prompt: contextualPrompt,
    temperature: 0.3,     ← 低温度，回答更保守准确
    maxTokens: 1024,
  });

Prompt 结构：
  ┌─────────────────────────────────┐
  │ 系统指令（角色定义 + 行为约束）    │
  │ == 检索到的相关内容 ==            │
  │ [1] 来源：doc.pdf 第3页          │
  │ 原文内容...                      │
  │ ---                              │
  │ [2] 来源：doc.pdf 第7页          │
  │ 原文内容...                      │
  │ == 用户问题 ==                   │
  │ 用户的问题                       │
  └─────────────────────────────────┘
```

## rag 整体数据流

### 索引阶段（一次性，写操作）

```ts
PDF 文件
  │
  ▼ pdf.ts: extractPdfPages()
逐页文本 [{page: 1, text: "..."}, {page: 2, text: "..."}, ...]
  │
  ▼ pdf.ts: buildChunks()
文本块列表 [{id, text, source, page}, ...]     ← chunk_size=500, overlap=50
  │
  ▼ embedder.ts: embed()   (批量，每批32条)
向量列表 [[0.12, -0.34, ...], ...]             ← 384维向量
  │
  ▼ store.ts: upsertChunks()
写入 Chroma（去重，跳过已存在 ID）
```

### 检索阶段（每次问答，读操作）

```ts
用户问题："如何配置XXX？"
  │
  ▼ embedder.ts: embedOne()
问题向量 [0.08, -0.21, ...]
  │
  ▼ store.ts: search()     # 余弦相似度检索 or 关键词检索  -> 混合检索
TopK 结果 [{text, source, page, score}, ...]  # 根据 score 获取 topK
  │
  ▼ rag.ts: generateAnswer()
拼接成 Context + 构造 Prompt
  │
  ▼ Vercel AI SDK: generateText()
最终答案（含引用来源）
```

## 关键设计决策

### 为什么用本地 Embedding 而不是 OpenAI Embedding API？

1. 零成本：不产生 API 费用
2. 无网络依赖：索引阶段完全离线
3. 数据安全：文档内容不上传第三方
4. 效果足够好：multilingual-MiniLM 在中文语义检索上表现良好

### 为什么选 Chroma？而不是 milvus

`npm install @zilliz/milvus2-sdk-node` [milvus文档](https://milvus.io/api-reference/node/v2.6.x/Client/MilvusClient.md)
Chroma 是目前生态最成熟的开源向量数据库之一，JS/TS 客户端完善，支持持久化、元数据过滤、多种相似度函数，适合从开发到生产的完整链路。

### Vercel AI SDK 的价值

相比直接调用 openai npm 包，Vercel AI SDK 的核心优势：

- Provider 抽象：createOpenAI / createAnthropic / createGoogle 统一接口
- Streaming 支持：generateText → streamText 一行切换
- 工具调用（Tool Use）：内置结构化输出和函数调用支持
- 未来扩展：可无缝接入 useChat hook 做 Web UI

## 扩展方向

### 混合检索（Hybrid Search）

当前只用向量检索（语义匹配），加入 BM25 关键词检索后用 RRF（倒数排名融合）合并两路结果，召回率提升显著。

## 小练习项目

我建议你做一个非常具体的小目标：
给当前项目加一个“课程章节问答 RAG”。
例如用户问：

```
s06 和 s09 的区别是什么？
```

harness 做：

```
1. 从 docs/zh 里检索相关章节
2. 找到 s06 context compact 和 s09 memory system
3. 注入相关片段
4. 回答区别
```

第一版可以不接模型，只打印检索结果。第二版再接模型回答。
