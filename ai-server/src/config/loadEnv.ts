import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(currentDir, "../../.env"),
  // MCP 走 stdio，stderr 会被客户端当作服务日志展示，屏蔽 dotenv 的启动 banner
  quiet: true,
});
