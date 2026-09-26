// @ts-nocheck
// Supabase Edge Function: create-tenant-user
//
// 在指定租户下新建用户：建 GoTrue 账号 -> 建 sys_users（带 tenant_id）-> 赋角色。
//
// 为什么不用浏览器端 supabase.auth.signUp：
//   1) signUp 会把当前管理员的会话顶掉，只能再靠 setSession 恢复，中间态极易出错
//   2) 邮箱已注册时 Supabase 出于安全会返回一个「混淆的假 user」，
//      拿它的 id 建出来的 sys_users 记录永远登不上，且没有任何报错
//   3) signUp 只能给自己建，没法顺手把 tenant_id 和角色一起写对
//
// 纯 fetch 实现（与 reset-user-password 一致），避免在 Edge Runtime 启动时联网
// 下载 npm 依赖，规避自托管环境的容器外网 DNS 解析失败问题。
//
// 环境变量（Supabase 运行时自动注入）：
//   SUPABASE_URL              -> 内部 API 网关地址（自托管通常为 http://kong:8000）
//   SUPABASE_SERVICE_ROLE_KEY -> service_role 密钥
//   SUPABASE_ANON_KEY         -> anon 密钥（用于以调用方身份判定超管）
//
// 请求体 (JSON):
//   {
//     "email": "user@acme.com",       // 必填，登录账号
//     "password": "******",           // 必填，初始密码，>= 6 位
//     "username": "zhangsan",         // 必填，租户内唯一（deploy_50 已改成租户内唯一）
//     "real_name": "张三",
//     "phone": "138...",
//     "status": "1",
//     "role_ids": [2, 5],             // 可选
//     "tenant_id": 3                  // 仅 super_admin 可指定，普通管理员忽略
//   }
//
// 返回:
//   成功 -> { "success": true, "userId": 12, "authId": "<uuid>", "tenantId": 3 }
//   失败 -> { "success": false, "error": "<message>" } (HTTP 4xx/5xx)

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
  const anonKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";

  if (!supabaseUrl || !serviceRoleKey) {
    return json(
      { success: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      500,
    );
  }

  const adminHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
  };

  // --------------------------------------------------------------------------
  // 1) 校验调用方身份
  // --------------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const callerRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: anonKey },
  });
  if (!callerRes.ok) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }
  const caller = await callerRes.json();
  const callerAuthId: string = caller?.id;
  if (!callerAuthId) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  // --------------------------------------------------------------------------
  // 2) 解析调用方租户与超管身份
  //    超管用调用方 token 去跑 RPC：它依赖 auth.uid()，用 service_role 调会恒为 false。
  //    租户归属用 service_role 直查 sys_users —— sys_users 的 SELECT 策略要求
  //    has_table_permission，用调用方 token 反而可能查不到自己。
  // --------------------------------------------------------------------------
  const superAdminRes = await fetch(
    `${supabaseUrl}/rest/v1/rpc/current_user_is_super_admin`,
    {
      method: "POST",
      headers: { Authorization: authHeader, apikey: anonKey, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const isSuperAdmin = superAdminRes.ok
    ? (await superAdminRes.json()) === true
    : false;

  const callerRowsRes = await fetch(
    `${supabaseUrl}/rest/v1/sys_users?select=id,tenant_id&auth_id=eq.${encodeURIComponent(
      callerAuthId,
    )}`,
    { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } },
  );
  if (!callerRowsRes.ok) {
    return json({ success: false, error: "Failed to resolve caller profile" }, 500);
  }
  const callerRows = await callerRowsRes.json();
  const callerTenantId: number | null = callerRows?.[0]?.tenant_id ?? null;

  if (!isSuperAdmin && callerTenantId === null) {
    return json(
      { success: false, error: "当前账号未分配租户，无法创建用户" },
      403,
    );
  }

  // --------------------------------------------------------------------------
  // 3) 解析请求体
  // --------------------------------------------------------------------------
  let payload: {
    email?: string;
    password?: string;
    username?: string;
    real_name?: string;
    phone?: string;
    status?: string;
    role_ids?: number[];
    tenant_id?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const email = (payload.email || "").trim().toLowerCase();
  const password = payload.password || "";
  const username = (payload.username || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: "邮箱格式不正确" }, 400);
  }
  if (password.length < 6) {
    return json({ success: false, error: "初始密码至少 6 位" }, 400);
  }
  if (!username) {
    return json({ success: false, error: "用户名不能为空" }, 400);
  }

  // 目标租户：只有超管能指定别人的租户，普通管理员一律落到自己租户
  let targetTenantId: number | null = isSuperAdmin
    ? (payload.tenant_id ?? callerTenantId)
    : callerTenantId;

  if (targetTenantId === null || targetTenantId === undefined) {
    return json({ success: false, error: "未指定租户" }, 400);
  }

  // --------------------------------------------------------------------------
  // 4) 用户名在目标租户内唯一（deploy_50 后唯一键是 (tenant_id, username)）
  // --------------------------------------------------------------------------
  const dupRes = await fetch(
    `${supabaseUrl}/rest/v1/sys_users?select=id&username=eq.${encodeURIComponent(
      username,
    )}&tenant_id=eq.${targetTenantId}&is_deleted=eq.n`,
    { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } },
  );
  if (dupRes.ok) {
    const dupRows = await dupRes.json();
    if (Array.isArray(dupRows) && dupRows.length > 0) {
      return json({ success: false, error: `用户名「${username}」在本租户已存在` }, 409);
    }
  }

  // --------------------------------------------------------------------------
  // 5) 角色校验：非超管不能把 super_admin 发出去
  //    super_admin 是基线角色，拿到它等于拿到跨租户看数据的全局通行证。
  // --------------------------------------------------------------------------
  // 先做数字规范化：role_ids 走 HTTP 进来的可能是字符串或负数，
  // 拼进 URL 前必须干净，否则 PostgREST 会报 22P02（invalid input syntax for type integer）。
  //
  // 注意 in. 过滤器的语法是 in.(2,5) —— 不能写成 in.((2),(5))。
  // 那种嵌套括号是给「值本身含逗号」的字符串用的，对整数列会被当成字面量解析，
  // 直接 400。踩过一次，别再改回去。
  const roleIds: number[] = Array.from(
    new Set(
      (Array.isArray(payload.role_ids) ? payload.role_ids : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  );

  if (roleIds.length > 0) {
    const rolesRes = await fetch(
      `${supabaseUrl}/rest/v1/sys_roles?select=id,role_code,status&is_deleted=eq.n&id=in.(${roleIds.join(
        ",",
      )})`,
      { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } },
    );
    if (!rolesRes.ok) {
      const detail = await rolesRes.text().catch(() => "");
      return json(
        { success: false, error: `角色校验失败: ${detail || rolesRes.status}` },
        400,
      );
    }
    const roles = await rolesRes.json();
    const validIds: number[] = (roles || []).map((r: { id: number }) => r.id);
    const invalid = roleIds.filter((id) => !validIds.includes(id));
    if (invalid.length > 0) {
      return json(
        { success: false, error: `角色不存在或已删除: ${invalid.join(", ")}` },
        400,
      );
    }

    if (!isSuperAdmin) {
      const superRole = (roles || []).find(
        (r: { role_code: string }) => r.role_code === "super_admin",
      );
      if (superRole && roleIds.includes(superRole.id)) {
        return json(
          { success: false, error: "只有超级管理员可以授予 super_admin 角色" },
          403,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // 6) 建 GoTrue 账号
  //    email_confirm: true —— 自托管通常不发验证邮件，不确认的话用户登不进来。
  // --------------------------------------------------------------------------
  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        real_name: payload.real_name || null,
      },
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    // GoTrue 对「邮箱已注册」返回 422，这里转成明确的中文提示
    if (/registered|already/i.test(errText)) {
      return json({ success: false, error: `邮箱 ${email} 已被注册` }, 409);
    }
    return json(
      { success: false, error: errText || "Failed to create auth user" },
      400,
    );
  }

  const createdAuth = await createRes.json();
  const newAuthId: string | undefined = createdAuth?.id;

  if (!newAuthId) {
    return json({ success: false, error: "GoTrue 未返回用户 id" }, 500);
  }

  // 后续任一步失败都要回滚 auth 账号，否则会留下一个永远登不上的孤儿账号
  const rollbackAuth = async () => {
    try {
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(newAuthId)}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
    } catch {
      /* 回滚失败也只能忽略，主流程的错误信息更重要 */
    }
  };

  // --------------------------------------------------------------------------
  // 7) 建 sys_users
  //    service_role 绕过 RLS，表上的 DEFAULT current_tenant_id() 会解析成 NULL
  //    （JWT 里没有 auth.uid()），所以 tenant_id 必须显式写。
  // --------------------------------------------------------------------------
  const insertUserRes = await fetch(`${supabaseUrl}/rest/v1/sys_users`, {
    method: "POST",
    headers: {
      ...adminHeaders,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      auth_id: newAuthId,
      tenant_id: targetTenantId,
      username,
      real_name: payload.real_name || null,
      email,
      phone: payload.phone || null,
      password_hash: "$supabase_auth$",
      status: payload.status || "1",
      is_deleted: "n",
    }),
  });

  if (!insertUserRes.ok) {
    const errText = await insertUserRes.text();
    await rollbackAuth();
    return json(
      { success: false, error: `创建用户档案失败: ${errText}` },
      400,
    );
  }

  const insertedUser = await insertUserRes.json();
  const newUserId: number | undefined = insertedUser?.[0]?.id;

  if (!newUserId) {
    await rollbackAuth();
    return json({ success: false, error: "创建用户档案后未返回 id" }, 500);
  }

  // --------------------------------------------------------------------------
  // 8) 赋角色
  // --------------------------------------------------------------------------
  if (roleIds.length > 0) {
    const insertRolesRes = await fetch(`${supabaseUrl}/rest/v1/sys_user_roles`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(
        roleIds.map((roleId) => ({
          user_id: newUserId,
          role_id: roleId,
          tenant_id: targetTenantId,
          is_deleted: "n",
        })),
      ),
    });

    if (!insertRolesRes.ok) {
      const errText = await insertRolesRes.text();
      // 档案已建、角色没赋上：不回滚整条，让用户先能登录，管理员可再补角色
      return json(
        {
          success: true,
          partial: true,
          warning: `用户已创建，但赋角色失败: ${errText}`,
          userId: newUserId,
          authId: newAuthId,
          tenantId: targetTenantId,
        },
        200,
      );
    }
  }

  return json({
    success: true,
    userId: newUserId,
    authId: newAuthId,
    tenantId: targetTenantId,
  });
});
