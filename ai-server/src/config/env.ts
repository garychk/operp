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
  /** 知识库文件解析（本地 CPU，不打模型）：默认 30 次/分钟/用户 */
  RATE_LIMIT_KNOWLEDGE_PARSE_PER_MIN: z.coerce.number().int().positive().default(30),

  /**
   * 知识库向量维度，必须与 sys_ai_knowledge_chunks.embedding 的 vector(N) 一致（deploy_30 起为 768）。
   * 改了列维度才需要动这里，否则保持默认即可。
   */
  KNOWLEDGE_EMBEDDING_DIM: z.coerce.number().int().positive().default(768),

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

  /**
   * Waffo Pancake 在线订阅收款（deploy_84）。
   * 全部可选：未配置时订阅相关端点返回 503，不影响其余功能。
   * 私钥两种给法：WAFFO_PRIVATE_KEY（支持字面量 \n）或 WAFFO_PRIVATE_KEY_BASE64（CI 推荐）。
   */
  WAFFO_MERCHANT_ID: z.string().optional(),
  WAFFO_PRIVATE_KEY: z.string().optional(),
  WAFFO_PRIVATE_KEY_BASE64: z.string().optional(),
  WAFFO_STORE_ID: z.string().optional(),
  /** 按月订阅商品 ID（Dashboard 创建或 scripts/waffo-setup.ts 生成） */
  WAFFO_MONTHLY_PRODUCT_ID: z.string().optional(),
  WAFFO_ENVIRONMENT: z.enum(["test", "prod"]).default("test"),
  WAFFO_CHECKOUT_CURRENCY: z.string().default("USD"),
});

export const env = schema.parse(process.env);
