import { supabase } from "../config/supabase.js";

export interface KnowledgeDoc {
  id: number;
  title: string;
  content: string;
  tags?: string[] | null;
  source_type?: string | null;
  source_ref?: string | null;
  category?: string | null;
}

export async function searchKnowledgeDocs(query: string, limit = 5) {
  const q = query.trim();
  const { data, error } = await supabase
    .from("sys_ai_knowledge_docs")
    .select("id, title, content, tags, source_type, source_ref, category")
    .eq("is_active", true)
    .or(`title.ilike.%${q}%,content.ilike.%${q}%,tags.cs.{${q}}`)
    .limit(limit);

  if (error) throw error;
  return (data || []) as KnowledgeDoc[];
}
