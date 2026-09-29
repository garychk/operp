// 必须是第一个 import：把 console.log 改道到 stderr，避免污染 stdio 的协议帧
import "./stdioGuard.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { env } from "../config/env.js";
import { probeSupabaseConnection } from "../config/supabaseProbe.js";
import { describeMcpIdentity, resolveMcpIdentity } from "./auth.js";
import { registerReadOnlyTools } from "./tools.js";

/**
 * OPERP MCP 服务（stdio 传输）。
 *
 * 与 HTTP 服务的关系：两者是同一进程模型的两个入口，共用 config / services / tools 三层，
 * 只有「入口 + 工具形状」不同。HTTP 服务面向前端对话（多轮、自然语言），
 * MCP 面向客户端工具调用（单次、结构化入参）。
 *
 * 启动方式：node dist/mcp/server.js（或开发时 npm run mcp）。
 * 身份在启动时解析一次 —— stdio 是长驻进程，一个客户端实例对应一个身份。
 */

const SERVER_NAME = "operp-erp";
const SERVER_VERSION = "0.1.0";

async function main() {
  // 身份解析失败就直接退出，不要让进程以「无租户」状态继续跑
  const identity = await resolveMcpIdentity();
  console.error(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} 身份：${describeMcpIdentity(identity)}`);

  await probeSupabaseConnection();
  console.error(`[mcp] Supabase 连接正常：${env.SUPABASE_URL}`);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadOnlyTools(server, identity);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[mcp] stdio 传输就绪，等待客户端调用（只读模式）");
  console.error(
    "[mcp] 可用工具：erp_list_entities / erp_describe_entity / erp_count_records / "
      + "erp_finance_summary / erp_business_analysis / erp_search_knowledge",
  );
}

main().catch((error) => {
  console.error(
    `[mcp] 启动失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
