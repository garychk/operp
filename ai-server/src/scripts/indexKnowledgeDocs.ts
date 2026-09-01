import { supabase } from "../config/supabase.js";
import {
  indexKnowledgeDocument,
  resolveEmbeddingProvider,
  type KnowledgeDoc,
} from "../services/knowledgeBase.js";

const args = new Set(process.argv.slice(2));
const docIdArg = process.argv.find((arg) => arg.startsWith("--doc-id="));
const docId = docIdArg ? Number(docIdArg.split("=").slice(1).join("=")) : undefined;
const runAll = args.has("--all") || !Number.isFinite(docId);

async function fetchDocs() {
  let query = supabase
    .from("sys_ai_knowledge_docs")
    .select("id, title, content, tags, source_type, source_ref, category")
    .eq("is_active", true)
    .order("updated_at", { ascending: false });

  if (!runAll && Number.isFinite(docId)) {
    query = query.eq("id", docId as number);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as KnowledgeDoc[];
}

async function main() {
  const provider = await resolveEmbeddingProvider();
  if (!provider) {
    throw new Error(
      "未找到可用于知识库向量化的 embedding provider。请在 AI 设置里增加一个 Ollama 或其它 embeddings provider。",
    );
  }
  const docs = await fetchDocs();

  if (!docs.length) {
    console.log("[ai-server] 没有需要索引的知识库文档");
    return;
  }

  console.log(
    `[ai-server] 开始索引 ${docs.length} 篇知识库文档，provider=${provider.model || "unknown"}`,
  );

  let successCount = 0;
  let failedCount = 0;

  for (const doc of docs) {
    try {
      const result = await indexKnowledgeDocument(doc, provider);
      successCount += 1;
      console.log(
        `[ai-server] indexed doc=${doc.id} title="${doc.title}" chunks=${result.chunkCount}`,
      );
    } catch (error) {
      failedCount += 1;
      console.error(`[ai-server] 索引失败 doc=${doc.id} title="${doc.title}"`, error);
    }
  }

  console.log(
    `[ai-server] 索引完成 success=${successCount} failed=${failedCount}`,
  );

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[ai-server] 知识库索引脚本执行失败", error);
  process.exit(1);
});
