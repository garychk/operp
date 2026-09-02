CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.sys_ai_knowledge_chunks (
  id BIGSERIAL PRIMARY KEY,
  doc_id BIGINT NOT NULL REFERENCES public.sys_ai_knowledge_docs(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_sys_ai_knowledge_chunks_doc
  ON public.sys_ai_knowledge_chunks(doc_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_sys_ai_knowledge_chunks_embedding
  ON public.sys_ai_knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_ai_knowledge_chunks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_ai_knowledge_chunks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sys_ai_knowledge_chunks_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_ai_knowledge_chunks_id_seq TO service_role;

ALTER TABLE public.sys_ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage ai knowledge chunks"
  ON public.sys_ai_knowledge_chunks;
CREATE POLICY "Authenticated users can manage ai knowledge chunks"
  ON public.sys_ai_knowledge_chunks FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_chunks(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.25,
  match_count INT DEFAULT 8
)
RETURNS TABLE (
  chunk_id BIGINT,
  doc_id BIGINT,
  title VARCHAR,
  content TEXT,
  category VARCHAR,
  source_type VARCHAR,
  source_ref TEXT,
  similarity FLOAT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    c.id,
    d.id,
    d.title,
    c.content,
    d.category,
    d.source_type,
    d.source_ref,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.sys_ai_knowledge_chunks c
  JOIN public.sys_ai_knowledge_docs d ON d.id = c.doc_id
  WHERE d.is_active = TRUE
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(match_count, 20);
$$;

GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_chunks(
  vector(1536), FLOAT, INT
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_chunks(
  vector(1536), FLOAT, INT
) TO service_role;
