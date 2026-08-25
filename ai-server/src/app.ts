import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { healthRouter } from "./api/health.routes.js";
import { aiRouter } from "./api/ai.routes.js";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.ALLOWED_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/health", healthRouter);
  app.use("/api/ai", aiRouter);

  return app;
}
