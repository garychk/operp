import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { probeSupabaseConnection } from "./config/supabaseProbe.js";

const maskSecret = (value: string, visible = 4) => {
  const trimmed = value.trim();
  if (trimmed.length <= visible * 2) {
    return `${trimmed.slice(0, Math.min(4, trimmed.length))}***`;
  }
  return `${trimmed.slice(0, visible)}***${trimmed.slice(-visible)}`;
};

console.log("[ai-server] env check:", {
  supabaseUrl: env.SUPABASE_URL,
  supabaseServiceRoleKey: maskSecret(env.SUPABASE_SERVICE_ROLE_KEY),
  port: env.PORT,
});

const app = createApp();

try {
  await probeSupabaseConnection();
  console.log("[ai-server] supabase probe: OK");
  app.listen(env.PORT, () => {
    console.log(`[ai-server] listening on port ${env.PORT}`);
  });
} catch (error) {
  console.error("[ai-server] supabase probe: FAILED");
  console.error(error);
  process.exit(1);
}
