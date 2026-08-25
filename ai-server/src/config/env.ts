import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default("gpt-5.1"),
  ALLOWED_ORIGIN: z.string().default("http://localhost:5173"),
});

export const env = schema.parse(process.env);
