import { Router } from "express";
import { z } from "zod";
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
      endpoint: z.string().optional(),
      model: z.string().optional(),
      apiType: z.enum(["proxy", "ollama"]).optional(),
      apiKey: z.string().optional(),
      temperature: z.number().optional(),
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

      await runChatGraphStream(parsed.data, async (event) => {
        if (event.type === "step") {
          send("step", event);
          return;
        }
        send("final", event.result);
      });

      res.end();
      return;
    }

    const result = await runChatGraph(parsed.data);
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
