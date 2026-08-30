import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { runChatGraph, runChatGraphStream } from "../ai/graph.js";

export const aiRouter = Router();

const chatSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.number().int().optional(),
  text: z.string().min(1),
  skill: z.enum(["auto", "analysis", "create", "action", "baq", "chat"]).optional(),
  provider: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  context: z
    .object({
      page: z.string().optional(),
      current_focus: z.any().optional(),
      recent_messages: z.array(z.any()).optional(),
    })
    .optional(),
});

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  apiType: z.enum(["proxy", "ollama"]).optional(),
  apiKey: z.string().optional(),
  temperature: z.number().optional(),
});

const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providers: z.array(providerSchema).default([]),
  activeProviderId: z.string().optional(),
  temperature: z.number().optional(),
  redactSensitiveData: z.boolean().optional(),
  maxContextMessages: z.number().optional(),
});

async function resolveProviderConfig(provider?: { id?: string; name?: string }) {
  const { data, error } = await supabase
    .from("sys_config")
    .select("config_json")
    .eq("category_code", "ai")
    .eq("is_deleted", "n")
    .maybeSingle();

  if (error) throw error;

  const settings = aiSettingsSchema.parse(data?.config_json || {});
  const matched = settings.providers.find((item) => {
    if (!provider?.id) return false;
    if (item.id === provider.id) return true;
    if (provider.name && item.name === provider.name) return true;
    return false;
  });

  if (!matched) {
    throw new Error(`未找到对应的 AI provider：${provider?.id || provider?.name || "unknown"}`);
  }

  console.log("[ai-server] resolved provider:", {
    requestProvider: provider,
    matchedProvider: matched,
  });

  return matched;
}

const wantsStream = (req: { body?: { stream?: unknown }; headers: Record<string, unknown> }) => {
  const accept = String(req.headers.accept || "");
  return req.body?.stream === true || accept.includes("text/event-stream");
};

const errorToMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

aiRouter.post("/chat", async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolvedProvider = parsed.data.provider
      ? await resolveProviderConfig(parsed.data.provider)
      : undefined;

    const requestBody = {
      ...parsed.data,
      provider: resolvedProvider
        ? {
            id: resolvedProvider.id,
            name: resolvedProvider.name,
            endpoint: resolvedProvider.endpoint,
            model: resolvedProvider.model,
            apiType: resolvedProvider.apiType,
            apiKey: resolvedProvider.apiKey,
            temperature: resolvedProvider.temperature,
          }
        : undefined,
    };

    if (wantsStream(req)) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      await runChatGraphStream(requestBody, async (event) => {
        if (event.type === "step") {
          send("step", event);
          return;
        }
        send("final", event.result);
      });

      res.end();
      return;
    }

    const result = await runChatGraph(requestBody);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: errorToMessage(error),
      });
      return;
    }
    try {
      res.write(`event: error\n`);
      res.write(
        `data: ${JSON.stringify({
          ok: false,
          error: errorToMessage(error),
        })}\n\n`,
      );
    } finally {
      res.end();
    }
  }
});
