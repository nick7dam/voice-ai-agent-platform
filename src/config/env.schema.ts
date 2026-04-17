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
  STT_PROVIDER: z.enum(['groq', 'local_whisper']).default('local_whisper'),
  REASONING_PROVIDER: z.enum(['groq', 'ollama']).default('ollama'),
  TTS_PROVIDER: z.enum(['groq', 'local_kokoro']).default('local_kokoro'),
  GROQ_API_KEY: z.string().default(''),
  GROQ_STT_MODEL: z.string().min(1).default('whisper-large-v3-turbo'),
  GROQ_LLM_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_LLM_MODEL: z.string().min(1).default('llama-3.1-8b-instant'),
  GROQ_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  GROQ_LLM_MAX_TOKENS: z.coerce.number().int().positive().default(160),
  LOCAL_STT_BASE_URL: z.string().url().default('http://localhost:8001'),
  LOCAL_STT_MODEL: z
    .string()
    .min(1)
    .default('Systran/faster-distil-whisper-large-v3'),
  LOCAL_STT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TTS_ENABLED: booleanFromEnv.default(false),
  GROQ_TTS_MODEL: z.string().min(1).default('canopylabs/orpheus-v1-english'),
  GROQ_TTS_VOICE: z.string().min(1).default('hannah'),
  GROQ_TTS_RESPONSE_FORMAT: z.literal('wav').default('wav'),
  GROQ_TTS_MAX_CHARS: z.coerce.number().int().positive().max(200).default(120),
  GROQ_TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TTS_PLAYBACK_MODE: z
    .enum(['first_sentence', 'first_segment', 'full'])
    .default('first_sentence'),
  TTS_CONCURRENCY: z.coerce.number().int().positive().max(5).default(2),
  TTS_CACHE_ENABLED: booleanFromEnv.default(true),
  TTS_ESTIMATED_PRICE_PER_MILLION_CHARS: z.coerce
    .number()
    .positive()
    .default(22),
  LOCAL_TTS_BASE_URL: z.string().url().default('http://localhost:8002'),
  LOCAL_TTS_MODEL: z.string().min(1).default('hexgrad/Kokoro-82M'),
  LOCAL_TTS_VOICE: z.string().min(1).default('af_heart'),
  LOCAL_TTS_SPEED: z.coerce.number().positive().default(1),
  LOCAL_TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  OLLAMA_BASE_URL: z.string().url().default('http://192.168.1.66:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:8b'),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(180_000),
  OLLAMA_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DEFAULT_TASK_KEY: z.string().min(1).default('general_voice_assistant'),
  TASK_CONFIG_PATH: z.string().min(1).default('data/tasks.local.json'),
  MAX_AUDIO_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25_000_000),
  MIN_STT_AUDIO_BYTES: z.coerce.number().int().positive().default(2500),
});

export type EnvConfig = z.infer<typeof envSchema>;
