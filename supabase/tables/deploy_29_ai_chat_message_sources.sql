ALTER TABLE public.sys_ai_chat_messages
  ADD COLUMN IF NOT EXISTS sources_json JSONB;

UPDATE public.sys_ai_chat_messages
SET sources_json = COALESCE(sources_json, '[]'::jsonb)
WHERE sources_json IS NULL;
