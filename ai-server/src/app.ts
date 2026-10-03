import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { healthRouter } from "./api/health.routes.js";
import { aiRouter } from "./api/ai.routes.js";
import { mrpRouter } from "./api/mrp.routes.js";
import { mpsRouter } from "./api/mps.routes.js";
import { financeRouter } from "./api/finance.routes.js";

export function createApp() {
  const app = express();
  const allowedOrigins = env.ALLOWED_ORIGIN.split(",").map((item) => item.trim());

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/health", healthRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/mrp", mrpRouter);
  app.use("/api/mps", mpsRouter);
  app.use("/api/finance", financeRouter);

  return app;
}
