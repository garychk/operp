import "./loadEnv.js";
import { z } from "zod";

/** .env 里写 `MCP_USER_ID=` 这种空值时，别让 coerce 把它变成 0 */
const emptyToUndefined = (value: unknown) =>
  value === "" || value === null || value === undefined ? undefined : value;

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LLM_PROVIDER: z.string().default("openai"),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().default("gpt-5.1"),
  ALLOWED_ORIGIN: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),

  /** LLM 可靠性：超时（ms）、重试次数、备模型（主模型重试耗尽后降级用） */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LLM_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_FALLBACK_BASE_URL: z.string().url().optional(),
  LLM_FALLBACK_API_KEY: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),

  /** 限流（次/分钟/用户） */
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_REINDEX_PER_MIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_HEAVY_PER_MIN: z.coerce.number().int().positive().default(10),

  /** 日志级别：debug < info < warn < error */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * MCP 服务配置。只有 src/mcp/server.ts 这个入口会强制校验，
   * 因此对原有的 HTTP 服务保持可选，不干扰现有部署。
   *
   * 身份解析优先级：MCP_API_KEYS（多身份） > MCP_API_KEY + MCP_USER_ID（单身份）。
   */
  MCP_API_KEYS: z.string().optional(),
  MCP_API_KEY: z.string().optional(),
  MCP_USER_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  /** 显式指定租户；仅当该用户是超管时才允许与自身租户不同 */
  MCP_TENANT_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
});

export const env = schema.parse(process.env);
