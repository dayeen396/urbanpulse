import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  CORS_ORIGIN: z.string()
    .default("http://localhost:5173,http://127.0.0.1:5173")
    .transform((value) => value.split(",").map((origin) => origin.trim()))
    .pipe(z.array(z.string().url()).min(1)),
  ML_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  STORAGE_DIR: z.string().min(1).default("uploads"),
  MAX_AUDIO_SIZE_BYTES: z.coerce.number().int().positive().max(10_000_000).default(10_000_000),
});

export const config = configSchema.parse(process.env);
