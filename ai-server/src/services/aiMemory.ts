import { supabase } from "../config/supabase.js";

export interface AiSessionMemory {
  session_id: string;
  user_id?: number;
  recent_messages: unknown[];
  last_intent?: string;
  last_target?: string;
  last_query_mode?: string;
  last_response_mode?: string;
  last_route?: string;
  last_route_label?: string;
  last_focus?: unknown;
  updated_at?: string;
}

export async function loadSessionMemory(sessionId: string) {
  const { data, error } = await supabase
    .from("sys_ai_chat_memory")
    .select("session_id, user_id, recent_messages, last_intent, last_target, last_query_mode, last_response_mode, last_route, last_route_label, last_focus, updated_at")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) throw error;
  return (data as AiSessionMemory | null) ?? null;
}

export async function saveSessionMemory(memory: AiSessionMemory) {
  const { error } = await supabase
    .from("sys_ai_chat_memory")
    .upsert(
      {
        session_id: memory.session_id,
        user_id: memory.user_id,
        recent_messages: memory.recent_messages,
        last_intent: memory.last_intent,
        last_target: memory.last_target,
        last_query_mode: memory.last_query_mode,
        last_response_mode: memory.last_response_mode,
        last_route: memory.last_route,
        last_route_label: memory.last_route_label,
        last_focus: memory.last_focus,
        updated_at: memory.updated_at || new Date().toISOString(),
      },
      { onConflict: "session_id" },
    );

  if (error) throw error;
}
