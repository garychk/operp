// @ts-nocheck
// Supabase Edge Function: reset-user-password
// 使用 service_role 权限重置指定用户的密码。
//
// 纯 fetch 实现，直接调用 GoTrue 管理接口，避免在 Edge Runtime 启动时
// 联网下载 npm 依赖（esm.sh / npm registry），从而规避自托管环境常见的
// 容器外网 DNS 解析失败问题。
//
// 环境变量（Supabase 运行时自动注入）：
//   SUPABASE_URL              -> 内部 API 网关地址（自托管通常为 http://kong:8000）
//   SUPABASE_SERVICE_ROLE_KEY -> service_role 密钥
//   SUPABASE_ANON_KEY         -> anon 密钥（用于校验调用方身份，可选回退）
//
// 请求体 (JSON):
//   { "userId": "<auth uuid>", "password": "<new password>" }
//
// 返回:
//   成功 -> { "success": true }
//   失败 -> { "success": false, "error": "<message>" } (HTTP 400/500)

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

  // 1) 校验调用方身份：必须携带有效的登录用户 token
  const authHeader = req.headers.get("Authorization") || "";
  const anonKey =
    req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";

  if (!authHeader) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: authHeader,
      apikey: anonKey,
    },
  });

  if (!userRes.ok) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  // 2) 使用 service_role 调 GoTrue 管理员接口重置密码
  const updateRes = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({ password }),
    },
  );

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    return json(
      { success: false, error: errText || "Failed to reset password" },
      400,
    );
  }

  return json({ success: true });
});
