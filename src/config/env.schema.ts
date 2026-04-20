import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return value;
}, z.boolean());

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  WS_PATH: z.string().min(1).default('/realtime'),
  DEFAULT_TASK_KEY: z.string().min(1).default('general_voice_assistant'),
  TASK_CONFIG_PATH: z.string().min(1).default('data/tasks.local.json'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:8b'),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(180_000),
  OLLAMA_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  OLLAMA_NUM_PREDICT: z.coerce.number().int().positive().default(120),
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(2048),
  OLLAMA_KEEP_ALIVE: z.string().min(1).default('30m'),
  OLLAMA_THINK: booleanFromEnv.default(false),
});

export type EnvConfig = z.infer<typeof envSchema>;
