import type { ThoughtChainItemType } from "@ant-design/x/es/thought-chain";
import { supabase } from "./supabase";

export interface AIChatSessionRecord {
  id: string;
  user_id: number | null;
  title: string;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  is_deleted: string;
}

export interface AIChatMessageRecord {
  id: string;
  session_id: string;
  user_id: number | null;
  role: "user" | "assistant";
  content: string;
  status: "loading" | "success" | "error" | null;
  trace_json: ThoughtChainItemType[] | null;
  focus_json: unknown;
  route: string | null;
  route_label: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveChatMessageInput {
  id: string;
  session_id: string;
  user_id?: number | null;
  role: "user" | "assistant";
  content: string;
  status?: "loading" | "success" | "error";
  trace_json?: ThoughtChainItemType[];
  focus_json?: unknown;
  route?: string | null;
  route_label?: string | null;
}

export async function fetchChatSessions(userId?: number | null) {
  let query = supabase
    .from("sys_ai_chat_sessions")
    .select(
      "id, user_id, title, last_message_preview, created_at, updated_at, last_message_at, is_deleted",
    )
    .eq("is_deleted", "n")
    .order("last_message_at", { ascending: false });

  if (typeof userId === "number") {
    query = query.eq("user_id", userId);
  } else {
    query = query.is("user_id", null);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as AIChatSessionRecord[];
}

export async function createChatSession(input: {
  id: string;
  user_id?: number | null;
  title: string;
}) {
  const now = new Date().toISOString();
  const payload = {
    id: input.id,
    user_id: input.user_id ?? null,
    title: input.title.trim() || "新对话",
    last_message_preview: null,
    last_message_at: now,
    updated_at: now,
    is_deleted: "n",
  };

  const { data, error } = await supabase
    .from("sys_ai_chat_sessions")
    .insert(payload)
    .select(
      "id, user_id, title, last_message_preview, created_at, updated_at, last_message_at, is_deleted",
    )
    .single();

  if (error) throw error;
  return data as AIChatSessionRecord;
}

export async function updateChatSession(
  sessionId: string,
  patch: Partial<{
    title: string;
    last_message_preview: string | null;
    last_message_at: string;
    updated_at: string;
    is_deleted: string;
  }>,
) {
  const { data, error } = await supabase
    .from("sys_ai_chat_sessions")
    .update({
      ...patch,
      updated_at: patch.updated_at || new Date().toISOString(),
    })
    .eq("id", sessionId)
    .select(
      "id, user_id, title, last_message_preview, created_at, updated_at, last_message_at, is_deleted",
    )
    .single();

  if (error) throw error;
  return data as AIChatSessionRecord;
}

export async function fetchChatMessages(sessionId: string) {
  const { data, error } = await supabase
    .from("sys_ai_chat_messages")
    .select(
      "id, session_id, user_id, role, content, status, trace_json, focus_json, route, route_label, created_at, updated_at",
    )
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data || []) as AIChatMessageRecord[];
}

export async function saveChatMessage(input: SaveChatMessageInput) {
  const now = new Date().toISOString();
  const payload = {
    id: input.id,
    session_id: input.session_id,
    user_id: input.user_id ?? null,
    role: input.role,
    content: input.content,
    status: input.status ?? "success",
    trace_json: input.trace_json ?? null,
    focus_json: input.focus_json ?? null,
    route: input.route ?? null,
    route_label: input.route_label ?? null,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("sys_ai_chat_messages")
    .upsert(payload, { onConflict: "id" })
    .select(
      "id, session_id, user_id, role, content, status, trace_json, focus_json, route, route_label, created_at, updated_at",
    )
    .single();

  if (error) throw error;
  return data as AIChatMessageRecord;
}

export async function deleteChatSession(sessionId: string) {
  const now = new Date().toISOString();

  const { error: sessionError } = await supabase
    .from("sys_ai_chat_sessions")
    .update({
      is_deleted: "y",
      updated_at: now,
    })
    .eq("id", sessionId);
  if (sessionError) throw sessionError;

  const { error: messageError } = await supabase
    .from("sys_ai_chat_messages")
    .delete()
    .eq("session_id", sessionId);
  if (messageError) throw messageError;

  const { error: memoryError } = await supabase
    .from("sys_ai_chat_memory")
    .delete()
    .eq("session_id", sessionId);
  if (memoryError) throw memoryError;
}

export function summarizeMessagePreview(content: string) {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
