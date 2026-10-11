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
        return (data as Record<string, unknown>[]).map((row) => ({
          docId: Number(row.doc_id),
          chunkId: Number(row.chunk_id),
          title: String(row.title || ""),
          content: String(row.content || ""),
          category: (row.category as string | null) || null,
          sourceType: (row.source_type as string | null) || null,
          sourceRef: (row.source_ref as string | null) || null,
          similarity: Number(row.similarity || 0),
        })) as KnowledgeChunkHit[];
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

export async function indexKnowledgeDocument(
  doc: KnowledgeDoc,
  provider: LlmProviderConfig,
) {
  // 解析不出来会抛出可直接展示给用户的中文错误（见 resolveEmbeddingProviderConfig）
  const embeddingProvider = await resolveEmbeddingProvider(provider);

  const chunks = doc.content
    .split(/\n{2,}|(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

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
