/**
 * stdio 传输下的 stdout 保护。
 *
 * MCP 的 stdio 传输把 stdout 当作 JSON-RPC 帧通道，写进去的任何非协议内容
 * 都会让客户端解析失败（表现为「服务器未返回有效响应」这类含糊报错，很难定位）。
 *
 * 但现有业务代码里有运行期 console.log —— 例如 erpTools 的业务分析会打印生成的 SQL
 * （`[ai-server] analysis plan raw:`）。这些日志在 HTTP 模式下完全正常，
 * 不能为了 MCP 把它们删掉，所以在 MCP 入口统一改道到 stderr。
 *
 * 必须在 server.ts 里作为第一个 import 引入：ESM 按 import 顺序求值模块体，
 * 放在最前面才能保证早于其它模块的顶层代码生效。
 */

const toStderr =
  (original: (...args: unknown[]) => void) =>
  (...args: unknown[]) => {
    original.apply(console, args);
  };

// console.error / console.warn 本来就写 stderr，保持原样
console.log = toStderr(console.error.bind(console));
console.info = console.log;
console.debug = console.log;
