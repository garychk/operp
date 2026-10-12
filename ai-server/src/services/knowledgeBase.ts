import { supabase } from "../config/supabase.js";
import { tenantScopeFilter } from "../config/tenantContext.js";
import { callEmbeddingModel, type LlmProviderConfig } from "../config/llm.js";
import {
  isEmbeddingCapableProvider,
  resolveEmbeddingProviderConfig,
} from "./aiProvider.js";

export interface KnowledgeDoc {
  id: number;
  title: string;
  content: string;
  tags?: string[] | null;
  source_type?: string | null;
  source_ref?: string | null;
  category?: string | null;
  tenant_id?: number | null;
}

export interface KnowledgeChunkHit {
  docId: number;
  chunkId?: number;
  title: string;
  content: string;
  category?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  similarity?: number;
}

export interface KnowledgeReindexResult {
  total: number;
  success: number;
  failed: number;
  details: Array<{
    docId: number;
    title: string;
    chunkCount?: number;
    error?: string;
  }>;
}

const escapeLike = (value: string) => value.replace(/[%_\\]/g, "\\$&");

const normalizeTerms = (query: string) =>
  query
    .replace(/[，。！？、；：,.!?;:]/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);

const toVectorLiteral = (values: number[]) =>
  `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;

const formatErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};


/**
 * 知识库向量列的维度。
 *
 * `sys_ai_knowledge_chunks.embedding` 是 `vector(768)`（deploy_28 建表为 1536、
 * deploy_30 为适配 nomic-embed-text 改成 768）。维度不匹配时 pgvector 会直接拒绝
 * 写入，报「expected 768 dimensions, not 1024」这类 SQL 错误 —— 用户看不懂，
 * 所以这里提前比对，给出可操作的提示。改了列维度就用环境变量同步覆盖。
 */
const EMBEDDING_DIM = (() => {
  const parsed = Number(process.env.KNOWLEDGE_EMBEDDING_DIM || 768);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 768;
})();

/** 维度不符时的统一人话报错 */
const dimensionMismatchError = (actual: number) =>
  new Error(
    `向量模型输出的维度是 ${actual}，而知识库向量列是 vector(${EMBEDDING_DIM})，无法写入。` +
      `请改用 ${EMBEDDING_DIM} 维的 embedding 模型（如 Ollama 的 nomic-embed-text、bge-base-zh、gte-base、e5-base；` +
      `注意 bge-m3 是 1024 维、text-embedding-3-small 是 1536 维，均不可用），` +
      `或同步调整数据库列维度（ALTER TABLE sys_ai_knowledge_chunks ... 并重建向量索引）。`,
  );

/** 把 pgvector 的维度报错也翻译成人话（兜底：本地常量与真实列不一致时） */
const translateEmbeddingDbError = (message: string) => {
  const matched = /expected (\d+) dimensions?, not (\d+)/i.exec(message);
  if (!matched) return message;
  return dimensionMismatchError(Number(matched[2])).message;
};

/**
 * 解析可用于向量化的 provider。
 *
 * **不再自己写一套判定规则**：命中特征就直接复用调用方传进来的 provider（省一次
 * 配置查询），否则整体回落到 `resolveEmbeddingProviderConfig` —— 也就是 AI 设置里
 * 「向量模型」下拉所驱动的那份逻辑（显式配置优先 → 特征自动挑）。两处规则必须同源，
 * 否则会出现「选中的 provider 过不了校验」的自相矛盾。
 */
export async function resolveEmbeddingProvider(
  preferred?: LlmProviderConfig | null,
  tenantId?: number | null,
) {
  if (isEmbeddingCapableProvider(preferred as never)) {
    return preferred as LlmProviderConfig;
  }
  return (await resolveEmbeddingProviderConfig(undefined, tenantId)) as LlmProviderConfig;
}

export async function searchKnowledgeDocs(query: string, limit = 8, tenantId?: number | null) {
  const terms = normalizeTerms(query);
  const orExpr =
    terms.length > 0
      ? terms
          .map((term) => {
            const escaped = escapeLike(term);
            return `title.ilike.%${escaped}%,content.ilike.%${escaped}%`;
          })
          .join(",")
      : `title.ilike.%${escapeLike(query.trim())}%,content.ilike.%${escapeLike(query.trim())}%`;

  const { data, error } = await supabase
    .from("sys_ai_knowledge_docs")
    .select("id, title, content, tags, source_type, source_ref, category")
    .eq("is_active", true)
    .or(orExpr)
    .or(tenantScopeFilter(tenantId))
    .limit(limit);

  if (error) throw error;
  return (data || []) as KnowledgeDoc[];
}

/**
 * 中文查询没有分词器：normalizeTerms 按标点/空格切完后，整句
 * 「采购订单操作流程怎么样的」会作为一个词，ILIKE 全文匹配必失败。
 * 这里对超过 4 字的中文词做 4 字滑窗（步长 2）展开 —— 「采购订单」「操作流程」
 * 这类真实词组自然出现在窗口里，ILIKE 就能命中带同词组的分片。
 */
const expandTermsForKeywordSearch = (terms: string[]): string[] => {
  const out = new Set(terms);
  for (const term of terms) {
    if (term.length > 4 && /[^\x00-\xff]/.test(term)) {
      for (let i = 0; i + 4 <= term.length; i += 2) {
        out.add(term.slice(i, i + 4));
      }
    }
  }
  return [...out].slice(0, 16);
};

/**
 * 关键字兜底召回（分片级）。
 *
 * 向量检索对「用语完全一致但语义漂移」的查询会失手，对 chunk.content 直接 ILIKE
 * 查询关键词，能保证含明确术语（如「采购订单」「审批」）的分片一定有机会进 prompt。
 * 关键词命中不带相似度，按「命中词组数 → 内容更短优先」打分排序，排在向量命中之后。
 */
const searchChunksByKeyword = async (
  query: string,
  limit: number,
  tenantId?: number | null,
): Promise<KnowledgeChunkHit[]> => {
  const terms = expandTermsForKeywordSearch(
    normalizeTerms(query).filter((term) => term.length >= 2),
  );
  if (!terms.length) return [];

  const orExpr = terms.map((term) => `content.ilike.%${escapeLike(term)}%`).join(",");
  const { data, error } = await supabase
    .from("sys_ai_knowledge_chunks")
    .select("id, doc_id, content, tenant_id")
    .or(orExpr)
    .or(tenantScopeFilter(tenantId))
    .limit(40);

  if (error) throw error;
  const rows = (data || []) as Array<{ id: number | string; doc_id: number | string; content: string }>;
  if (!rows.length) return [];

  // 客户端打分：命中越多不同词组越相关；平手时更短的片信息密度更高
  const ranked = rows
    .map((row) => ({
      row,
      score: terms.filter((term) => row.content.includes(term)).length,
    }))
    .sort((a, b) => b.score - a.score || a.row.content.length - b.row.content.length)
    .slice(0, limit);
  if (!ranked.length) return [];

  // 分片表不带标题（不依赖 PostgREST 嵌入，避免外键/关系探测的坑），按 doc_id 批量补
  const docIds = [...new Set(ranked.map(({ row }) => Number(row.doc_id)))];
  const { data: docsData } = await supabase
    .from("sys_ai_knowledge_docs")
    .select("id, title, category, source_type, source_ref")
    .in("id", docIds);
  const docById = new Map((docsData || []).map((doc) => [Number(doc.id), doc]));

  return ranked.map(({ row }) => {
    const doc = docById.get(Number(row.doc_id));
    return {
      docId: Number(row.doc_id),
      chunkId: Number(row.id),
      title: String(doc?.title || ""),
      content: String(row.content || ""),
      category: (doc?.category as string | null) || null,
      sourceType: (doc?.source_type as string | null) || null,
      sourceRef: (doc?.source_ref as string | null) || null,
    } as KnowledgeChunkHit;
  });
};

export async function searchKnowledgeRag(
  query: string,
  provider: LlmProviderConfig | undefined,
  limit = 8,
  tenantId?: number | null,
) {
  try {
    const embeddingProvider = await resolveEmbeddingProvider(provider, tenantId);
    if (!embeddingProvider) {
      throw new Error("No embedding provider configured");
    }

    const embedding = await callEmbeddingModel(query, embeddingProvider);
    // 提问侧同样要挡：维度不符时余弦相似度会报 SQL 错，被外层 catch 后静默降级为
    // 关键字搜索，用户只会觉得「怎么搜不准」，查不到真正原因。这里明确抛出来记日志。
    if (embedding.length && embedding.length !== EMBEDDING_DIM) {
      throw dimensionMismatchError(embedding.length);
    }
    if (embedding.length) {
      // 带租户的向量检索：原 match_ai_knowledge_chunks 是 SECURITY DEFINER，
      // 会把所有租户的知识一起召回。deploy_48 还没执行时回退到原函数并告警。
      let data: Record<string, unknown>[] | null = null;
      let error: { message?: string } | null = null;

      const scoped = await supabase.rpc("match_ai_knowledge_chunks_for_tenant", {
        query_embedding: toVectorLiteral(embedding),
        match_threshold: 0.2,
        match_count: limit,
        p_tenant_id: tenantId ?? null,
      });
      data = scoped.data;
      error = scoped.error;

      if (error && /PGRST202|Could not find the function/i.test(error.message || "")) {
        console.warn(
          "[ai-server] match_ai_knowledge_chunks_for_tenant 不存在，回退到未做租户过滤的旧函数（请先执行 deploy_48）",
        );
        const fallback = await supabase.rpc("match_ai_knowledge_chunks", {
          query_embedding: toVectorLiteral(embedding),
          match_threshold: 0.2,
          match_count: limit,
        });
        data = fallback.data;
        error = fallback.error;
      }

      if (error) throw error;
      if (data?.length) {
        const vectorHits = (data as Record<string, unknown>[]).map((row) => ({
          docId: Number(row.doc_id),
          chunkId: Number(row.chunk_id),
          title: String(row.title || ""),
          content: String(row.content || ""),
          category: (row.category as string | null) || null,
          sourceType: (row.source_type as string | null) || null,
          sourceRef: (row.source_ref as string | null) || null,
          similarity: Number(row.similarity || 0),
        })) as KnowledgeChunkHit[];

        // 混合召回：向量命中为主，关键字命中补位（去重后追加，总量 ≤ 2×limit）。
        // 关键字一路失败不致命 —— 打日志继续用向量结果。
        let keywordHits: KnowledgeChunkHit[] = [];
        try {
          keywordHits = await searchChunksByKeyword(query, limit, tenantId);
        } catch (keywordError) {
          console.warn("[ai-server] knowledge keyword search failed:", keywordError);
        }

        const seen = new Set(vectorHits.map((hit) => hit.chunkId));
        const merged = [
          ...vectorHits,
          ...keywordHits.filter((hit) => !seen.has(hit.chunkId)),
        ];
        return merged;
      }
    }
  } catch (error) {
    console.warn("[ai-server] knowledge vector search failed, fallback to keyword search:", error);
  }

  const docs = await searchKnowledgeDocs(query, limit, tenantId);
  return docs.map((doc) => ({
    docId: doc.id,
    title: doc.title,
    content: doc.content,
    category: doc.category,
    sourceType: doc.source_type,
    sourceRef: doc.source_ref,
  })) as KnowledgeChunkHit[];
}

/* ------------------------------------------------------------------ *
 * 分片（chunking）
 *
 * 旧实现 `content.split(/\n{2,}|(?<=[。！？.!?])\s+/)` 有三个致命伤：
 *  1. 英文句点后也断（`## 1.` 与 `系统概览` 被拆成两片）→ 章节标题变成空壳分片，
 *     短文本余弦相似度虚高，反而把真正的内容挤出 top-K；
 *  2. 每个句子独立成片 → 320 片全是碎句，逐片打 embedding 又慢又贵；
 *  3. 分片不带标题/章节上下文 → 「1. 点新增→选供应商」这种步骤片匹配不上
 *     「采购订单操作流程」这类提问。
 *
 * 现在按「标题分节 → 节内聚合到目标长度 → 拼标题路径前缀」三步走。
 * ------------------------------------------------------------------ */

/** 单片正文目标长度（字符）。embedding 模型对 200~800 字的中文块效果最好 */
const CHUNK_TARGET_CHARS = 500;
/** 超过这个长度的单段才做句子级硬切 */
const CHUNK_MAX_CHARS = 900;
/** 标题路径最多保留的层级（防超长前缀稀释正文） */
const CHUNK_PATH_DEPTH = 4;

const isNoiseLine = (line: string) =>
  /^(-{3,}|\*{3,}|_{3,}|\|\s*-{3,})/.test(line.trim()) || // --- / *** / 表格分隔行
  /^```/.test(line.trim()) ||
  /^<br\s*\/?>$/i.test(line.trim()) ||
  /^[-*]\s*\[[^\]]*\]\([^)]*\)\s*$/.test(line.trim()); // 目录里的纯链接列表项

/** 把超长段落按句子（退化为按行、再退化为硬切）切成 ≤ max 的片 */
const hardSplitLong = (text: string): string[] => {
  if (text.length <= CHUNK_MAX_CHARS) return [text];
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*/)
    .flatMap((s) => (s.length > CHUNK_MAX_CHARS ? s.split(/(?<=，,、)\s*/) : [s]));
  const pieces: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
    // 单句仍然超长（无标点的长表格行等）：直接硬切
    if (sentence.length > CHUNK_MAX_CHARS) {
      if (buf) {
        pieces.push(buf);
        buf = "";
      }
      for (let i = 0; i < sentence.length; i += CHUNK_TARGET_CHARS) {
        pieces.push(sentence.slice(i, i + CHUNK_TARGET_CHARS));
      }
      continue;
    }
    if (buf && buf.length + sentence.length > CHUNK_TARGET_CHARS) {
      pieces.push(buf);
      buf = sentence;
    } else {
      buf = buf ? buf + sentence : sentence;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
};

/** 节内分片：按空行分段 → 聚合到目标长度 → 超长段句子级硬切 */
const splitSectionBody = (body: string): string[] => {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !isNoiseLine(p))
    // 目录段（一整行塞了 3 个以上页内锚点链接）对检索毫无价值，整段丢弃
    .filter((p) => (p.match(/\]\(#[^)]*\)/g) || []).length < 3);
  const pieces: string[] = [];
  let buf = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_MAX_CHARS) {
      if (buf) {
        pieces.push(buf);
        buf = "";
      }
      pieces.push(...hardSplitLong(paragraph));
      continue;
    }
    if (buf && buf.length + paragraph.length + 2 > CHUNK_TARGET_CHARS) {
      pieces.push(buf);
      buf = paragraph;
    } else {
      buf = buf ? `${buf}\n\n${paragraph}` : paragraph;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
};

/**
 * markdown 感知分片。
 *
 * - `#`~`######` 标题行开新节，并维护「1. 进销存 > 6.2 采购业务」这样的章节路径；
 * - 独立成行的 `**加粗标题**`（手册里大量用于小节名，如「**采购订单操作流程**」）
 *   也当作子标题并入路径；
 * - 目录链接、分隔线等噪音行直接丢弃；
 * - 每片头部拼 `[文档标题] 章节 > 子节` 前缀 —— **前缀参与 embedding**，这样
 *   「采购订单操作流程是怎么走的」能直接命中带该路径的步骤片。
 */
export function buildKnowledgeChunks(content: string, title: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");

  const headingPath: (string | undefined)[] = [];
  let sectionPath: string[] = [];
  let sectionBody: string[] = [];
  const sections: Array<{ path: string[]; body: string }> = [];

  const flushSection = () => {
    const body = sectionBody.join("\n").trim();
    if (body) sections.push({ path: sectionPath, body });
    sectionBody = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    const boldLabel = /^\*\*([^*\n]{1,60})\*\*\s*:?\s*$/.exec(line);

    if (heading) {
      flushSection();
      const level = heading[1].length;
      headingPath.length = level - 1;
      headingPath[level - 1] = heading[2].trim();
      sectionPath = headingPath.filter(Boolean).slice(0, CHUNK_PATH_DEPTH) as string[];
      continue;
    }

    if (boldLabel) {
      flushSection();
      // 加粗小节挂在当前章节路径下，不改动 headingPath 本身
      sectionPath = [
        ...headingPath.filter(Boolean).slice(0, CHUNK_PATH_DEPTH - 1),
        boldLabel[1].trim(),
      ] as string[];
      continue;
    }

    sectionBody.push(line);
  }
  flushSection();

  const chunks: string[] = [];
  for (const section of sections) {
    const prefix = `[${title}]${section.path.length ? ` ${section.path.join(" > ")}` : ""}`;
    for (const piece of splitSectionBody(section.body)) {
      const text = piece.trim();
      // 过滤目录链接、纯符号等无信息量的碎片
      const informative = text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[|\s`#>*-]/g, "");
      if (informative.length < 6) continue;
      chunks.push(`${prefix}\n\n${text}`);
    }
  }
  return chunks;
}

export async function indexKnowledgeDocument(
  doc: KnowledgeDoc,
  provider: LlmProviderConfig,
) {
  // 解析不出来会抛出可直接展示给用户的中文错误（见 resolveEmbeddingProviderConfig）
  const embeddingProvider = await resolveEmbeddingProvider(provider);

  const chunks = buildKnowledgeChunks(doc.content, doc.title);

  if (!chunks.length) {
    throw new Error("文档正文为空，没有可向量化的内容。");
  }

  const payload = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const embedding = await callEmbeddingModel(chunks[index], embeddingProvider);

    // 提前比对维度：交给 pgvector 报错会得到「expected 768 dimensions, not 1024」
    // 这种 SQL 级信息，用户无从下手。
    if (embedding.length !== EMBEDDING_DIM) {
      throw dimensionMismatchError(embedding.length);
    }

    payload.push({
      doc_id: doc.id,
      chunk_index: index,
      content: chunks[index],
      embedding: toVectorLiteral(embedding),
      // service_role 下 current_user 不是真实用户，列的 DEFAULT current_tenant_id()
      // 会解析成 NULL，把分片变成「全局基线」对所有租户可见。这里显式带上归属。
      tenant_id: doc.tenant_id ?? null,
      metadata: {
        title: doc.title,
        category: doc.category,
        source_type: doc.source_type,
        source_ref: doc.source_ref,
      },
    });
  }

  await supabase.from("sys_ai_knowledge_chunks").delete().eq("doc_id", doc.id);
  const { error } = await supabase.from("sys_ai_knowledge_chunks").insert(payload);
  if (error) throw new Error(translateEmbeddingDbError(error.message || String(error)));
  return { docId: doc.id, chunkCount: payload.length };
}

/**
 * 取待索引的文档。
 *
 * @param docIds 限定文档：单个数或一批 id。**不传 = 全量重索引**（昂贵，
 *   每个文档都要逐块打 embedding），所以「导入后自动索引」务必传具体 id，
 *   别退化成把整个租户重算一遍。
 */
export async function fetchKnowledgeDocuments(
  docIds?: number | number[],
  tenantId?: number | null,
) {
  let query = supabase
    .from("sys_ai_knowledge_docs")
    .select("id, title, content, tags, source_type, source_ref, category, tenant_id")
    .eq("is_active", true)
    .or(tenantScopeFilter(tenantId))
    .order("updated_at", { ascending: false });

  const ids = (Array.isArray(docIds) ? docIds : [docIds])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (ids.length === 1) {
    query = query.eq("id", ids[0]);
  } else if (ids.length > 1) {
    query = query.in("id", ids);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as KnowledgeDoc[];
}

export async function reindexKnowledgeDocuments(
  provider: LlmProviderConfig,
  docIds?: number | number[],
  tenantId?: number | null,
) {
  const docs = await fetchKnowledgeDocuments(docIds, tenantId);
  const result: KnowledgeReindexResult = {
    total: docs.length,
    success: 0,
    failed: 0,
    details: [],
  };

  for (const doc of docs) {
    try {
      const indexed = await indexKnowledgeDocument(doc, provider);
      result.success += 1;
      result.details.push({
        docId: doc.id,
        title: doc.title,
        chunkCount: indexed.chunkCount,
      });
    } catch (error) {
      result.failed += 1;
      result.details.push({
        docId: doc.id,
        title: doc.title,
        error: formatErrorMessage(error),
      });
    }
  }

  return result;
}
