// 先加载 env：本文件模块级读取的 process.env.*（超时 / 重试 / 向量维度）依赖 .env 已就位。
import { env } from "./env.js";
import { logger } from "../services/logger.js";
import { recordTokenUsage } from "../services/tokenUsage.js";

const toInt = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

export interface LlmProviderConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  apiType?: "proxy" | "ollama";
  temperature?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * LLM 调用可靠性（#6）：
 * - 超时：非流式整体超时 LLM_TIMEOUT_MS（默认 30s），流式用「空闲超时」
 *   （每收到一个 chunk 就重置，默认 60s 没有新数据才中断）；
 * - 重试：网络错误 / 超时 / 429 / 5xx 指数退避重试 LLM_MAX_RETRIES 次（默认 2）；
 * - 降级：主模型重试耗尽后，若配置了 LLM_FALLBACK_BASE_URL 则用备模型再试一轮。
 *
 * 注意：流式请求一旦开始吐字就不重试（重试会导致前端出现重复文本），
 * 只覆盖「连不上 / 首包超时」阶段。
 */

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30_000);
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.LLM_STREAM_IDLE_TIMEOUT_MS || 60_000);
const MAX_RETRIES = Math.max(0, Number(process.env.LLM_MAX_RETRIES ?? 2));

const FALLBACK_BASE_URL = process.env.LLM_FALLBACK_BASE_URL;
const FALLBACK_API_KEY = process.env.LLM_FALLBACK_API_KEY;
const FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 请求侧声明的向量维度，与 `sys_ai_knowledge_chunks.embedding` 的 `vector(N)` 同源
 * （都来自 `KNOWLEDGE_EMBEDDING_DIM`，默认 768）。
 *
 * 为什么必须显式发：支持 MRL 的接口（Qwen 百炼 text-embedding-v3/v4、OpenAI
 * text-embedding-3-*、Gemini）**默认维度通常不是 768** —— 百炼 text-embedding-v4
 * 默认 1024。不发这个参数就会写进 768 的列时被 pgvector / 维度校验拦下。
 * 填 0 表示「不发 dimensions 参数」（少数老接口不认这个字段）。
 */
const EMBEDDING_REQUEST_DIM = env.KNOWLEDGE_EMBEDDING_DIM;

const toResponseUrl = (baseUrl: string) =>
  baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/chat/completions`;

/**
 * Ollama 端点归一化。
 *
 * 用户在 AI 设置里填的地址五花八门：`http://host:11434`、`.../api`、`.../api/chat`、
 * `.../v1`。旧实现只做「把结尾 /chat 换成 /embed」，填根地址就会拼出
 * `http://host:11434/embed`（404）—— 实测租户 3 的配置正是这种填法。
 * 这里按已知后缀归一（保留 /api、/v1 前缀），无法识别时补全官方路径。
 */
const OLLAMA_ENDPOINT_REWRITES: Record<"chat" | "embed", Array<[RegExp, string]>> = {
  chat: [
    [/\/v1\/embeddings$/, "/v1/chat/completions"],
    [/\/chat\/completions$/, "/chat/completions"],
    [/\/api\/embed$/, "/api/chat"],
    [/\/api\/embeddings$/, "/api/chat"],
    [/\/api\/chat$/, "/api/chat"],
    [/\/embed$/, "/chat"],
    [/\/embeddings$/, "/chat"],
    [/\/chat$/, "/chat"],
    [/\/api$/, "/api/chat"],
  ],
  embed: [
    [/\/v1\/chat\/completions$/, "/v1/embeddings"],
    [/\/chat\/completions$/, "/embeddings"],
    [/\/api\/chat$/, "/api/embed"],
    [/\/api\/embeddings$/, "/api/embed"],
    [/\/api\/embed$/, "/api/embed"],
    [/\/embeddings$/, "/embeddings"],
    [/\/chat$/, "/embed"],
    [/\/embed$/, "/embed"],
    [/\/api$/, "/api/embed"],
  ],
};

const normalizeOllamaUrl = (raw: string, kind: "chat" | "embed") => {
  const base = raw.replace(/\/+$/, "");
  for (const [pattern, replacement] of OLLAMA_ENDPOINT_REWRITES[kind]) {
    if (pattern.test(base)) return base.replace(pattern, replacement);
  }
  return `${base}/api/${kind}`;
};

const toChatUrl = (endpoint: string, apiType?: LlmProviderConfig["apiType"]) =>
  apiType === "ollama" ? normalizeOllamaUrl(endpoint, "chat") : toResponseUrl(endpoint);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 指数退避：0ms、800ms、1600ms…封顶 8s */
const backoffMs = (attempt: number) => Math.min(800 * 2 ** attempt, 8_000);

const isRetryableError = (error: unknown, status?: number) => {
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  // fetch 网络层错误（ECONNREFUSED / ETIMEDOUT / AbortError…）与解析失败都可重试
  return true;
};

/**
 * 带重试 + 降级的执行器。
 * fn(provider) 在每次尝试时重新构建请求（主/备模型的 provider 不同）。
 */
async function withRetryAndFallback<T>(
  scope: string,
  build: (provider: LlmProviderConfig | undefined) => Promise<T>,
  provider?: LlmProviderConfig,
): Promise<T> {
  const attempts: Array<LlmProviderConfig | undefined> = [provider];
  if (FALLBACK_BASE_URL) {
    attempts.push({
      ...provider,
      endpoint: FALLBACK_BASE_URL,
      apiKey: FALLBACK_API_KEY || provider?.apiKey,
      model: FALLBACK_MODEL || provider?.model,
    });
  }

  let lastError: unknown = null;

  for (let p = 0; p < attempts.length; p += 1) {
    const current = attempts[p];
    const isFallback = p > 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await build(current);
      } catch (error) {
        lastError = error;
        const status =
          error instanceof LlmHttpError ? error.status : undefined;
        if (!isRetryableError(error, status)) throw error;

        const isLastAttemptOfProvider = attempt === MAX_RETRIES;
        logger.warn("llm", `${scope} attempt failed`, {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES + 1,
          isFallback,
          status: status ?? null,
          error: logger.normalizeError(error),
        });

        if (!isLastAttemptOfProvider) {
          await sleep(backoffMs(attempt));
        }
      }
    }
  }

  throw lastError;
}

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LLM request failed: ${status}${body ? ` ${body.slice(0, 400)}` : ""}`);
    this.name = "LlmHttpError";
  }
}

const extractContent = (data: Record<string, unknown>) => {
  const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
  const first = choices[0] || {};
  const content =
    (typeof first.message === "object" && first.message !== null
      ? String((first.message as Record<string, unknown>).content || "")
      : "") ||
    String(first.text || "") ||
    String(data.reply || data.content || data.response || "");
  return content;
};

export async function callChatModel(
  messages: ChatMessage[],
  provider?: LlmProviderConfig,
  operation = "chat",
) {
  const endpoint = provider?.endpoint;
  if (!endpoint) {
    throw new Error("No model endpoint configured");
  }

  return withRetryAndFallback(
    "chat",
    async (activeProvider) => {
      const activeEndpoint = activeProvider?.endpoint || endpoint;
      const startedAt = Date.now();
      const response = await fetch(toChatUrl(activeEndpoint, activeProvider?.apiType), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(activeProvider?.apiKey ? { Authorization: `Bearer ${activeProvider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: activeProvider?.model,
          messages,
          stream: false,
          temperature: activeProvider?.temperature ?? 0.3,
        }),
        // 整体超时：面向「小 JSON 任务」（意图路由 / 字段提取）场景
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new LlmHttpError(response.status, errorText);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const usage = (data.usage ?? {}) as Record<string, unknown>;
      logger.info("llm", "chat ok", {
        durationMs: Date.now() - startedAt,
        model: activeProvider?.model,
        chars: extractContent(data).length,
      });
      // 旁路记录 token 消耗（不阻断，见 services/tokenUsage.ts）
      void recordTokenUsage({
        operation,
        model: activeProvider?.model,
        promptTokens: toInt(usage.prompt_tokens),
        completionTokens: toInt(usage.completion_tokens),
        totalTokens: toInt(usage.total_tokens),
      });
      return { raw: data, content: extractContent(data) };
    },
    provider,
  );
}

/**
 * 流式对话（#7 真流式）。
 *
 * - proxy（OpenAI 兼容）：SSE，`data: {"choices":[{"delta":{"content":"..."}}]}`，
 *   以 `data: [DONE]` 结束；
 * - ollama /api/chat：NDJSON，每行 `{"message":{"content":"..."},"done":false}`。
 *
 * onDelta 每收到一段增量文本回调一次；返回完整拼接后的内容。
 * 出错语义：首包之前（连接 / 握手 / 状态码）可安全重试；开始吐字后失败直接抛错，
 * 由调用方决定降级（此时前端已收到部分文本，不能重放整段）。
 */
export async function callChatModelStream(
  messages: ChatMessage[],
  provider: LlmProviderConfig | undefined,
  onDelta: (text: string) => void,
  operation = "chat",
): Promise<string> {
  const endpoint = provider?.endpoint;
  if (!endpoint) {
    throw new Error("No model endpoint configured");
  }

  return withRetryAndFallback(
    "chat-stream",
    async (activeProvider) => {
      const activeEndpoint = activeProvider?.endpoint || endpoint;
      const startedAt = Date.now();
      let received = "";
      // 流式最后一个 chunk 的 usage（OpenAI 兼容需显式开 include_usage）
      let usage: Record<string, unknown> = {};

      const controller = new AbortController();
      // 空闲超时：每次收到数据都重置；连接阶段同样受此约束
      let idleTimer: NodeJS.Timeout | undefined;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
      };
      resetIdleTimer();

      try {
        const response = await fetch(toChatUrl(activeEndpoint, activeProvider?.apiType), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(activeProvider?.apiKey
              ? { Authorization: `Bearer ${activeProvider.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: activeProvider?.model,
            messages,
            stream: true,
            temperature: activeProvider?.temperature ?? 0.3,
            // 让 OpenAI 兼容接口在最后一个 chunk 返回 usage（token 统计依赖它）
            ...(activeProvider?.apiType === "ollama"
              ? {}
              : { stream_options: { include_usage: true } }),
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text().catch(() => "");
          // 首包之前失败：走重试 / 降级是安全的（前端还没收到任何字）
          throw new LlmHttpError(response.status, errorText);
        }

        const isOllama = activeProvider?.apiType === "ollama";
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        const handlePayload = (payload: string) => {
          if (isOllama) {
            // NDJSON：每行一个完整 JSON
            for (const line of payload.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                const message = parsed.message as Record<string, unknown> | undefined;
                const piece = String(message?.content ?? parsed.response ?? "");
                if (piece) {
                  received += piece;
                  onDelta(piece);
                }
                // Ollama 最后一行 done=true 时带 eval 计数
                if (parsed.done === true) {
                  usage = {
                    prompt_tokens: parsed.prompt_eval_count,
                    completion_tokens: parsed.eval_count,
                    total_tokens:
                      Number(parsed.prompt_eval_count ?? 0) +
                      Number(parsed.eval_count ?? 0),
                  };
                }
              } catch {
                // 忽略不完整行
              }
            }
            return;
          }
          // OpenAI 兼容 SSE
          for (const line of payload.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              const choices = Array.isArray(parsed.choices)
                ? (parsed.choices as Record<string, unknown>[])
                : [];
              const delta = choices[0]?.delta as Record<string, unknown> | undefined;
              const piece = String(delta?.content ?? "");
              if (piece) {
                received += piece;
                onDelta(piece);
              }
              // 最后一个 chunk（choices 为空）带 usage
              if (parsed.usage) {
                usage = parsed.usage as Record<string, unknown>;
              }
            } catch {
              // 忽略无法解析的心跳 / 注释行
            }
          }
        };

        while (true) {
          resetIdleTimer();
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lastDoubleNewline = buffer.lastIndexOf("\n\n");
          if (lastDoubleNewline >= 0) {
            handlePayload(buffer.slice(0, lastDoubleNewline + 2));
            buffer = buffer.slice(lastDoubleNewline + 2);
          }
        }
        handlePayload(buffer);

        logger.info("llm", "chat-stream ok", {
          durationMs: Date.now() - startedAt,
          model: activeProvider?.model,
          chars: received.length,
        });
        // 旁路记录 token 消耗（不阻断，见 services/tokenUsage.ts）
        void recordTokenUsage({
          operation,
          model: activeProvider?.model,
          promptTokens: toInt(usage.prompt_tokens),
          completionTokens: toInt(usage.completion_tokens),
          totalTokens: toInt(usage.total_tokens),
        });
        return received;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    },
    provider,
  );
}

export async function callEmbeddingModel(
  input: string,
  provider?: LlmProviderConfig,
  operation = "embedding",
) {
  const endpoint = provider?.endpoint;
  if (!endpoint) {
    throw new Error("No model endpoint configured");
  }

  return withRetryAndFallback(
    "embedding",
    async (activeProvider) => {
      const activeEndpoint = activeProvider?.endpoint || endpoint;
      const normalized = activeEndpoint.replace(/\/+$/, "");
      const isOllama = activeProvider?.apiType === "ollama";

      // 注意用 activeProvider 而不是外层 provider：走 LLM_FALLBACK_* 降级时
      // 备模型的 apiType 可能不同，用错会拼出对方不认的路径。
      const target = isOllama
        ? normalizeOllamaUrl(normalized, "embed")
        : normalized.endsWith("/embeddings")
          ? normalized
          : normalized.endsWith("/chat/completions")
            ? normalized.replace(/\/chat\/completions$/, "/embeddings")
            : normalized.endsWith("/chat")
              ? normalized.replace(/\/chat$/, "/embeddings")
              : `${normalized}/embeddings`;

      /**
       * 组装请求体。
       *
       * `withDimensions=false` 只在「端点明确不认 dimensions」时用（见下面的兜底重试）。
       */
      const buildBody = (withDimensions: boolean) => {
        const body: Record<string, unknown> = {
          model: activeProvider?.model,
          input,
        };
        // Ollama 的 /api/embed 没有 dimensions 概念（维度由模型自身决定），
        // 只认 truncate（超长输入截断）。
        if (isOllama) body.truncate = true;
        else if (withDimensions) body.dimensions = EMBEDDING_REQUEST_DIM;
        return JSON.stringify(body);
      };

      const request = async (withDimensions: boolean) => {
        const response = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(activeProvider?.apiKey
              ? { Authorization: `Bearer ${activeProvider.apiKey}` }
              : {}),
          },
          body: buildBody(withDimensions),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (response.ok) return response;
        const errorText = await response.text().catch(() => "");
        throw new LlmHttpError(response.status, errorText);
      };

      const wantsDimensions = !isOllama && EMBEDDING_REQUEST_DIM > 0;
      let response: Response;
      try {
        response = await request(wantsDimensions);
      } catch (error) {
        // 少数 OpenAI 兼容服务不认 dimensions（老模型 / 自建网关），直接 400。
        // 这类接口维度是固定的，去掉参数重试一次即可 —— 万一带回别的维度，
        // knowledgeBase 的维度校验会给出「实际 X 维、期望 768 维」的人话报错，
        // 不会静默写坏数据。
        const errorBody = error instanceof LlmHttpError ? error.body : "";
        const unsupported =
          wantsDimensions &&
          error instanceof LlmHttpError &&
          error.status === 400 &&
          /dimension/i.test(errorBody);

        if (!unsupported) throw error;

        logger.warn("llm", "embedding 端点不认 dimensions 参数，已去掉后重试", {
          endpoint: target,
          model: activeProvider?.model,
          response: errorBody.slice(0, 200),
        });
        response = await request(false);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const first = Array.isArray(data.data)
        ? (data.data[0] as Record<string, unknown> | undefined)
        : undefined;
      const embedding = Array.isArray(data.embeddings)
        ? ((data.embeddings[0] as unknown[]) || [])
        : Array.isArray(first?.embedding)
          ? (first.embedding as unknown[])
          : Array.isArray(data.embedding)
            ? (data.embedding as unknown[])
            : [];
      const vector = embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value));

      if (!vector.length) {
        throw new Error(
          `Embedding model returned empty vector. endpoint=${target}, model=${activeProvider?.model || "unknown"}`,
        );
      }

      // 旁路记录 token 消耗（OpenAI 兼容 embedding 返回 usage；Ollama 不返回则跳过）
      const usage = (data.usage ?? {}) as Record<string, unknown>;
      void recordTokenUsage({
        operation,
        model: activeProvider?.model,
        promptTokens: toInt(usage.prompt_tokens),
        completionTokens: toInt(usage.completion_tokens),
        totalTokens: toInt(usage.total_tokens),
      });

      return vector;
    },
    provider,
  );
}
