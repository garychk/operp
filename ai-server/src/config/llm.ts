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
  const endpoint = provider?.endpoint;
  // console.log("[ai-server] callChatModel provider:", {
  //   endpoint: provider?.endpoint,
  //   model: provider?.model,
  //   apiType: provider?.apiType,
  //   hasApiKey: Boolean(provider?.apiKey),
  //   temperature: provider?.temperature,
  // });
  if (!endpoint) {
    throw new Error("No model endpoint configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider?.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider?.model,
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

export async function callEmbeddingModel(
  input: string,
  provider?: LlmProviderConfig,
) {
  const endpoint = provider?.endpoint;
  if (!endpoint) {
    throw new Error("No model endpoint configured");
  }

  const normalizedEndpoint = endpoint.replace(/\/$/, "");
  const embeddingEndpoint = provider?.apiType === "ollama"
    ? normalizedEndpoint.endsWith("/embed")
      ? normalizedEndpoint
      : normalizedEndpoint.endsWith("/embeddings")
        ? normalizedEndpoint.replace(/\/embeddings$/, "/embed")
        : normalizedEndpoint.endsWith("/chat")
          ? normalizedEndpoint.replace(/\/chat$/, "/embed")
          : `${normalizedEndpoint}/embed`
    : normalizedEndpoint.endsWith("/embeddings")
      ? normalizedEndpoint
    : normalizedEndpoint.endsWith("/chat/completions")
      ? normalizedEndpoint.replace(/\/chat\/completions$/, "/embeddings")
      : normalizedEndpoint.endsWith("/chat")
        ? normalizedEndpoint.replace(/\/chat$/, "/embeddings")
        : `${normalizedEndpoint}/embeddings`;

  const response = await fetch(embeddingEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider?.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider?.model,
      input,
      ...(provider?.apiType === "ollama" ? { truncate: true } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Embedding request failed: ${response.status}${errorText ? ` ${errorText}` : ""}`,
    );
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
      `Embedding model returned empty vector. endpoint=${embeddingEndpoint}, model=${provider?.model || "unknown"}`,
    );
  }

  return vector;
}
