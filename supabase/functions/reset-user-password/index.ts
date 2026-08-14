// Supabase Edge Function: reset-user-password
// 使用 service_role 权限重置指定用户的密码。
// 部署：supabase functions deploy reset-user-password
// 本地调试：supabase functions serve
//
// 环境变量（Supabase 运行时自动注入）：
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// 请求体 (JSON):
//   { "userId": "<auth uuid>", "password": "<new password>" }
//
// 返回:
//   成功 -> { "success": true }
//   失败 -> { "success": false, "error": "<message>" } (HTTP 400/500)

// import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createClient } from '@supabase/supabase-js';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json(
      { success: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      500,
    );
  }

  let payload: { userId?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { userId, password } = payload;

  if (!userId || typeof userId !== "string") {
    return json({ success: false, error: "userId is required" }, 400);
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    return json({ success: false, error: "password is required (min 6 chars)" }, 400);
  }

  // 校验调用方身份：必须携带有效的 Authorization Bearer（登录用户）
  const authHeader = req.headers.get("Authorization") || "";
  const anonKey =
    req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  // 使用 service_role 客户端执行重置
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: updateError } = await adminClient.auth.admin.updateUserById(
    userId,
    { password },
  );

  if (updateError) {
    return json(
      { success: false, error: updateError.message || "Failed to reset password" },
      400,
    );
  }

  return json({ success: true });
});
