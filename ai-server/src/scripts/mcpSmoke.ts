/**
 * OPERP MCP 冒烟测试：以真实 stdio 客户端身份拉起 dist/mcp/server.js，把
 * 「工具清单 → 只读查询 → 建单草稿 → 提交建单 → 动作校验 → 提交错误映射」
 * 打一遍。
 *
 * 为什么必须走真实入口：手工拼 SQL / 直接 INSERT 会漏掉整类
 * 「默认值掩盖缺失赋值」的 bug（历史踩过：NOT NULL DEFAULT 0 的列在真实写入
 * 路径上没人赋值 → 金额恒为 0 且不报错）。只有打真实调用路径才能发现。
 *
 * 用法（在 ai-server 目录下）：
 *   npm run build
 *   MCP_API_KEY=operp_xxx npm run mcp:smoke
 *   MCP_API_KEY=operp_xxx npm run mcp:smoke -- --commit
 *
 * ⚠️ 默认**不写任何业务数据**：
 *      - 只读调用；
 *      - 生成单据草稿（只落 sys_ai_pending_actions，业务表不动）；
 *      - 负向用例（状态不允许过账、重复提交、草稿不存在）。
 *    加 --commit 才会真正建一张单据，脚本执行完会立即软删除它。
 *
 * MCP_API_KEY 必须是目标租户里某位用户签发的密钥（前端「MCP 服务 → 我的密钥」）。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../config/supabase.js";
import { DOCUMENT_TYPES } from "../services/documentService.js";

const SERVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/mcp/server.js",
);

/** 取样本主数据时的偏好关键词：命中则用第一条，否则退回表里第一条 */
const CUSTOMER_HINTS = ["微软", "客户"];
const PRODUCT_HINTS = ["空调", "压缩机", "机器人"];

/** 可过账的单据类型：用于验证「状态不允许过账」这条闸门 */
const POSTABLE_TYPES = ["purchase_receipt", "sales_delivery", "material_issue"];

const args = process.argv.slice(2);
const doCommit = args.includes("--commit");
const apiKey = String(process.env.MCP_API_KEY || "").trim();

if (!apiKey) {
  console.error(
    "缺少 MCP_API_KEY。请先在网页端「MCP 服务 → 我的密钥」签发一把，再：\n"
      + "  MCP_API_KEY=operp_xxx npm run mcp:smoke [-- --commit]",
  );
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 极简 JSON-RPC over stdio 客户端
 * ------------------------------------------------------------------ */

interface RpcResponse {
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
}

interface ToolOutcome {
  isError: boolean;
  text: string;
}

const child = spawn(process.execPath, [SERVER_PATH], {
  // cwd = ai-server，与服务端自己的启动方式一致（.env 从这里读取）
  cwd: path.resolve(SERVER_PATH, "../../.."),
  env: { ...process.env, MCP_API_KEY: apiKey },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrTail = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderrTail = (stderrTail + chunk.toString()).slice(-4000);
});

const pending = new Map<number, (value: RpcResponse) => void>();
let stdoutBuffer = "";
let nextId = 1;

child.stdout.on("data", (chunk: Buffer) => {
  stdoutBuffer += chunk.toString();
  let newline = stdoutBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    newline = stdoutBuffer.indexOf("\n");
    if (!line) continue;
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      // stdio 是被协议独占的通道，任何非 JSON 输出都是致命问题，直接报出来
      console.error("[非 JSON 协议输出]", line.slice(0, 300));
      continue;
    }
    if (message.id === undefined) continue;
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

const request = (method: string, params: unknown): Promise<RpcResponse> =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`请求超时：${method}`)), 60000);
  });

const notify = (method: string, params: unknown): void => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
};

const callTool = async (name: string, toolArgs: Record<string, unknown>): Promise<ToolOutcome> => {
  const response = await request("tools/call", { name, arguments: toolArgs });
  const text = (response.result?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return { isError: Boolean(response.result?.isError), text };
};

/** 工具返回的文本里固定带一个 json 代码块（机器可读部分） */
const extractJson = <T>(text: string): T | null => {
  const matched = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!matched) return null;
  try {
    return JSON.parse(matched[1]) as T;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ *
 * 断言与报告
 * ------------------------------------------------------------------ */

const results: Array<{ step: string; ok: boolean }> = [];

const check = (step: string, ok: boolean, detail: string): void => {
  results.push({ step, ok });
  console.log(`\n${ok ? "PASS" : "FAIL"} | ${step}`);
  console.log(detail.slice(0, 1200));
};

/** 从业务表取一条真实名称，用于建单草稿（service_role 绕过 RLS，必须带 tenant_id） */
const pickName = async (table: string, hints: string[]): Promise<string | null> => {
  const { data } = await supabase.from(table).select("name").eq("is_deleted", "n").limit(50);
  const names = ((data || []) as unknown as Array<Record<string, unknown>>)
    .map((row) => String(row.name ?? ""))
    .filter(Boolean);
  return names.find((name) => hints.some((hint) => name.includes(hint))) ?? names[0] ?? null;
};

/** 取某类单据最新一单的单号（用于动作闸门用例） */
const latestDocumentNo = async (documentType: string): Promise<string | null> => {
  const meta = DOCUMENT_TYPES[documentType];
  if (!meta) return null;
  const { data } = await supabase
    .from(meta.headerTable)
    .select(`id, ${meta.noField}`)
    .eq("is_deleted", "n")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as unknown as Record<string, unknown> | null;
  return row ? String(row[meta.noField] ?? "") || null : null;
};

const main = async (): Promise<void> => {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "operp-mcp-smoke", version: "1.0.0" },
  });
  check(
    "initialize：服务名 operp-erp",
    init.result?.serverInfo?.name === "operp-erp",
    JSON.stringify(init.result?.serverInfo ?? init.error ?? null),
  );
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  const tools = list.result?.tools || [];
  const writeToolNames = tools
    .filter((tool) => tool.annotations?.readOnlyHint === false)
    .map((tool) => tool.name)
    .sort()
    .join(",");
  check(
    "tools/list：共 10 个工具，读写注解正确",
    tools.length === 10
      && writeToolNames === "erp_commit_document,erp_create_document,erp_document_action",
    tools
      .map(
        (tool) =>
          `${tool.name}  readOnly=${String(tool.annotations?.readOnlyHint)}`
          + `  destructive=${String(tool.annotations?.destructiveHint)}`,
      )
      .join("\n"),
  );

  /* ---------------- 只读 ---------------- */

  const recent = await callTool("erp_query_documents", { document_type: "sales_order" });
  check("只读：按类型列出最近单据", !recent.isError && recent.text.includes("销售订单"), recent.text);

  const missingNo = await callTool("erp_query_documents", { document_no: "ZZ99999999" });
  check(
    "只读：不存在的单号给出明确错误，而不是空列表",
    missingNo.isError && missingNo.text.includes("没有找到单号"),
    missingNo.text,
  );

  /* ---------------- 建单 ---------------- */

  const badType = await callTool("erp_create_document", {
    document_type: "不存在的单据类型",
    lines: [{ product_name: "x", quantity: 1 }],
  });
  check(
    "建单：未知类型被拒并列出可用类型",
    badType.isError && badType.text.includes("未识别"),
    badType.text,
  );

  const customer = await pickName("erp_customers_s_539dcf81_b", CUSTOMER_HINTS);
  const product = await pickName("erp_products_s_539dcf81_b", PRODUCT_HINTS);

  if (!customer || !product) {
    console.log("\n跳过建单用例：租户里没有可用的客户 / 物料样本。");
  } else {
    const draft = await callTool("erp_create_document", {
      document_type: "sales_order",
      party_name: customer,
      remark: "MCP 冒烟测试（脚本会自动清理）",
      lines: [{ product_name: product, quantity: 2, unit_price: 3000 }],
    });
    const draftJson = extractJson<{ action_id?: number; draft?: boolean }>(draft.text);
    const actionId = draftJson?.action_id;
    check(
      `建单草稿：${customer} / ${product}（不写业务表）`,
      !draft.isError && draftJson?.draft === true && typeof actionId === "number",
      draft.text,
    );

    if (doCommit && typeof actionId === "number") {
      const committed = await callTool("erp_commit_document", { action_id: actionId });
      const committedJson = extractJson<{
        executed?: boolean;
        focus?: { id?: number };
        output?: { document_no?: string };
      }>(committed.text);
      const createdNo = committedJson?.output?.document_no ?? null;
      const createdId = Number(committedJson?.focus?.id);
      check("提交草稿：真正建单", Boolean(committedJson?.executed && createdNo), committed.text);

      const again = await callTool("erp_commit_document", { action_id: actionId });
      check(
        "重复提交同一草稿被拒（不会重复建单）",
        again.isError && again.text.includes("已经执行过"),
        again.text,
      );

      // 清理：草稿态单据没有台账 / 库存副作用，软删即可
      if (Number.isFinite(createdId) && createdId > 0) {
        const meta = DOCUMENT_TYPES.sales_order;
        await supabase.from(meta.detailTable).update({ is_deleted: "y" }).eq(meta.fkField, createdId);
        await supabase.from(meta.headerTable).update({ is_deleted: "y" }).eq("id", createdId);
        const { data: left } = await supabase
          .from(meta.headerTable)
          .select("id")
          .eq("id", createdId)
          .eq("is_deleted", "n");
        check(
          `清理测试单据 ${createdNo}（id=${createdId}）`,
          (left || []).length === 0,
          "已软删除；审计留痕保留在 sys_ai_pending_actions / sys_ai_operation_logs",
        );
      }
    } else {
      // 不提交就把草稿置为 cancelled：草稿本身不会变成业务数据，但没必要留在库里
      if (typeof actionId === "number") {
        await supabase
          .from("sys_ai_pending_actions")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", actionId);
      }
      check(
        "跳过真实建单（默认不写业务数据，加 --commit 开启）",
        true,
        `草稿 action_id=${String(actionId ?? "-")} 已生成并作废，业务表未改动。`,
      );
    }
  }

  /* ---------------- 动作闸门 ---------------- */

  const salesOrderNo = await latestDocumentNo("sales_order");
  const noPostRoute = salesOrderNo
    ? await callTool("erp_document_action", { document_no: salesOrderNo, action: "post" })
    : null;
  check(
    `动作：销售订单无过账入口（样本 ${salesOrderNo ?? "无"}）`,
    noPostRoute
      ? noPostRoute.isError && noPostRoute.text.includes("没有过账入口")
      : true,
    noPostRoute?.text ?? "（租户里没有销售订单样本，跳过）",
  );

  let postableNo: string | null = null;
  for (const type of POSTABLE_TYPES) {
    postableNo = await latestDocumentNo(type);
    if (postableNo) break;
  }
  const gate = postableNo
    ? await callTool("erp_document_action", { document_no: postableNo, action: "post" })
    : null;
  check(
    `动作：过账闸门生效（样本 ${postableNo ?? "无"}）`,
    gate
      ? gate.text.includes("不能过账") || (!gate.isError && gate.text.includes("action_id"))
      : true,
    gate
      ? `${gate.text}\n（状态不允许 → 可读拒绝；状态允许 → 已产出草稿但未提交）`
      : "（租户里没有可过账类型的单据样本，跳过）",
  );

  /* ---------------- 提交错误映射 ---------------- */

  const noDraft = await callTool("erp_commit_document", { action_id: 999999999 });
  check(
    "提交：不存在的草稿给出可读错误",
    noDraft.isError && noDraft.text.includes("没有找到待确认的草稿"),
    noDraft.text,
  );

  const failed = results.filter((item) => !item.ok);
  console.log("\n=== 汇总 ===");
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log(`失败：${failed.map((item) => item.step).join("；")}`);

  child.kill();
  process.exit(failed.length ? 1 : 0);
};

main().catch((error: unknown) => {
  console.error("\n冒烟测试异常：", error);
  console.error(`服务端 stderr（末段）：\n${stderrTail}`);
  child.kill();
  process.exit(1);
});
