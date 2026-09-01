import { supabase } from "../config/supabase.js";
import { callEmbeddingModel, type LlmProviderConfig } from "../config/llm.js";

export interface KnowledgeDoc {
  id: number;
  title: string;
  content: string;
  tags?: string[] | null;
  source_type?: string | null;
  source_ref?: string | null;
  category?: string | null;
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

const EMBEDDING_MODEL_PATTERN =
  /(embed|embedding|nomic-embed|bge-|mxbai-embed|text-embedding|gte-|e5-)/i;

const isEmbeddingCapableProvider = (provider?: LlmProviderConfig | null) => {
  if (!provider?.endpoint) return false;
  const endpoint = provider.endpoint.toLowerCase();
  const model = String(provider.model || "");
  return (
    endpoint.includes("/embeddings") ||
    EMBEDDING_MODEL_PATTERN.test(model) ||
    /embed/i.test(endpoint)
  );
};

export async function resolveEmbeddingProvider(preferred?: LlmProviderConfig | null) {
  if (isEmbeddingCapableProvider(preferred)) {
    return preferred as LlmProviderConfig;
  }

  const { data, error } = await supabase
    .from("sys_config")
    .select("config_json")
    .eq("category_code", "ai")
    .eq("is_deleted", "n")
    .maybeSingle();
  if (error) throw error;

  const config = (data?.config_json || {}) as {
    providers?: LlmProviderConfig[];
  };
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const found = providers.find((item) => isEmbeddingCapableProvider(item));
  return found || null;
}

export async function searchKnowledgeDocs(query: string, limit = 8) {
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
    .limit(limit);

  if (error) throw error;
  return (data || []) as KnowledgeDoc[];
}

export async function searchKnowledgeRag(
  query: string,
  provider: LlmProviderConfig | undefined,
  limit = 8,
) {
  try {
    const embeddingProvider = await resolveEmbeddingProvider(provider);
    if (!embeddingProvider) {
      throw new Error("No embedding provider configured");
    }

    const embedding = await callEmbeddingModel(query, embeddingProvider);
    if (embedding.length) {
      const { data, error } = await supabase.rpc("match_ai_knowledge_chunks", {
        query_embedding: toVectorLiteral(embedding),
        match_threshold: 0.2,
        match_count: limit,
      });

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

  const docs = await searchKnowledgeDocs(query, limit);
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
  const embeddingProvider = await resolveEmbeddingProvider(provider);
  if (!embeddingProvider) {
    throw new Error(
      "未找到可用于向量化的 embedding provider。请在 AI 设置里增加一个 Ollama / OpenAI 兼容的 embeddings provider。",
    );
  }

  const chunks = doc.content
    .split(/\n{2,}|(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const payload = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const embedding = await callEmbeddingModel(chunks[index], embeddingProvider);
    payload.push({
      doc_id: doc.id,
      chunk_index: index,
      content: chunks[index],
      embedding: toVectorLiteral(embedding),
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
  if (error) throw error;
  return { docId: doc.id, chunkCount: payload.length };
}

export async function fetchKnowledgeDocuments(docId?: number) {
  let query = supabase
    .from("sys_ai_knowledge_docs")
    .select("id, title, content, tags, source_type, source_ref, category")
    .eq("is_active", true)
    .order("updated_at", { ascending: false });

  if (Number.isFinite(docId)) {
    query = query.eq("id", docId as number);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as KnowledgeDoc[];
}

export async function reindexKnowledgeDocuments(provider: LlmProviderConfig, docId?: number) {
  const docs = await fetchKnowledgeDocuments(docId);
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
