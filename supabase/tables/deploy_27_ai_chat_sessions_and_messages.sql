CREATE TABLE IF NOT EXISTS public.sys_ai_chat_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id BIGINT,
  title VARCHAR(200) NOT NULL DEFAULT '新对话',
  last_message_preview TEXT,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n'
);

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_sessions_user_last_message
  ON public.sys_ai_chat_sessions(user_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_sessions_is_deleted
  ON public.sys_ai_chat_sessions(is_deleted, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.sys_ai_chat_messages (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES public.sys_ai_chat_sessions(id) ON DELETE CASCADE,
  user_id BIGINT,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status VARCHAR(20),
  trace_json JSONB,
  focus_json JSONB,
  route TEXT,
  route_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_messages_session_created
  ON public.sys_ai_chat_messages(session_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_messages_user_created
  ON public.sys_ai_chat_messages(user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_ai_chat_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_ai_chat_messages TO authenticated;

ALTER TABLE public.sys_ai_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sys_ai_chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can manage ai chat sessions" ON public.sys_ai_chat_sessions;
CREATE POLICY "Authenticated users can manage ai chat sessions"
  ON public.sys_ai_chat_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can manage ai chat messages" ON public.sys_ai_chat_messages;
CREATE POLICY "Authenticated users can manage ai chat messages"
  ON public.sys_ai_chat_messages FOR ALL TO authenticated USING (true) WITH CHECK (true);
