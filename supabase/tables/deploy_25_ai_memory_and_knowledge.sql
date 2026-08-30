CREATE TABLE IF NOT EXISTS public.sys_ai_chat_memory (
  session_id VARCHAR(64) PRIMARY KEY,
  user_id BIGINT,
  recent_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_intent VARCHAR(50),
  last_target VARCHAR(50),
  last_query_mode VARCHAR(50),
  last_response_mode VARCHAR(50),
  last_route TEXT,
  last_route_label TEXT,
  last_focus JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_memory_user_id
  ON public.sys_ai_chat_memory(user_id);

CREATE TABLE IF NOT EXISTS public.sys_ai_knowledge_docs (
  id BIGSERIAL PRIMARY KEY,
  category VARCHAR(100),
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_type VARCHAR(50),
  source_ref TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_ai_knowledge_docs_active
  ON public.sys_ai_knowledge_docs(is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sys_ai_knowledge_docs_title_gin
  ON public.sys_ai_knowledge_docs USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_ai_chat_memory TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_ai_knowledge_docs TO authenticated;

ALTER TABLE public.sys_ai_chat_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sys_ai_knowledge_docs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can manage ai chat memory" ON public.sys_ai_chat_memory;
CREATE POLICY "Authenticated users can manage ai chat memory"
  ON public.sys_ai_chat_memory FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can manage ai knowledge docs" ON public.sys_ai_knowledge_docs;
CREATE POLICY "Authenticated users can manage ai knowledge docs"
  ON public.sys_ai_knowledge_docs FOR ALL TO authenticated USING (true) WITH CHECK (true);
