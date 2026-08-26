import { env } from "./env.js";

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

const toResponseUrl = (baseUrl: string) =>
  baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/chat/completions`;

export async function callChatModel(
  messages: ChatMessage[],
  provider?: LlmProviderConfig,
) {
  const endpoint =
    provider?.endpoint ||
    (env.LLM_BASE_URL ? toResponseUrl(env.LLM_BASE_URL) : undefined);
  if (!endpoint) {
    throw new Error("No model endpoint configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider?.apiKey || env.LLM_API_KEY
        ? { Authorization: `Bearer ${provider?.apiKey || env.LLM_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      model: provider?.model || env.LLM_MODEL,
      messages,
      stream: false,
      temperature: provider?.temperature ?? 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed: ${response.status}${errorText ? ` ${errorText}` : ""}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
  const first = choices[0] || {};
  const content =
    (typeof first.message === "object" && first.message !== null
      ? String((first.message as Record<string, unknown>).content || "")
      : "") ||
    String(first.text || "") ||
    String(data.reply || data.content || data.response || "");

  return {
    raw: data,
    content,
  };
}
