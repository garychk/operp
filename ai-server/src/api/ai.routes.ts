import { Router } from "express";
import { z } from "zod";
import { runChatGraph } from "../ai/graph.js";

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
    const result = await runChatGraph(parsed.data);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
