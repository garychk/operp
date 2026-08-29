import { supabase } from "./supabase.js";

export async function probeSupabaseConnection() {
  const { error } = await supabase.from("sys_config").select("id").limit(1);

  if (error) {
    throw error;
  }
}
