import { APP_CONFIG } from '../common/constants/injection-tokens';
import { envSchema } from './env.schema';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  wsPath: string;
  defaultTaskKey: string;
  taskConfigPath: string;
  maxAudioBufferBytes: number;
  minSttAudioBytes: number;
  stt: {
    provider: 'groq' | 'local_whisper';
    localBaseUrl: string;
    localModel: string;
    localTimeoutMs: number;
    configured: boolean;
  };
  reasoning: {
    provider: 'groq' | 'ollama';
  };
  groq: {
    apiKey: string;
    sttModel: string;
    llmBaseUrl: string;
    llmModel: string;
    llmTimeoutMs: number;
    llmMaxTokens: number;
    configured: boolean;
  };
  tts: {
    provider: 'groq' | 'local_kokoro';
    enabled: boolean;
    model: string;
    voice: string;
    responseFormat: 'wav';
    maxChars: number;
    timeoutMs: number;
    playbackMode: 'first_sentence' | 'first_segment' | 'full';
    concurrency: number;
    cacheEnabled: boolean;
    estimatedPricePerMillionChars: number;
    localBaseUrl: string;
    localSpeed: number;
    configured: boolean;
  };
  ollama: {
    baseUrl: string;
    model: string;
    requestTimeoutMs: number;
    healthTimeoutMs: number;
    configured: boolean;
  };
}

export function loadAppConfig(): AppConfig {
  const env = envSchema.parse(process.env);

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    wsPath: env.WS_PATH,
    defaultTaskKey: env.DEFAULT_TASK_KEY,
    taskConfigPath: env.TASK_CONFIG_PATH,
    maxAudioBufferBytes: env.MAX_AUDIO_BUFFER_BYTES,
    minSttAudioBytes: env.MIN_STT_AUDIO_BYTES,
    stt: {
      provider: env.STT_PROVIDER,
      localBaseUrl: env.LOCAL_STT_BASE_URL.replace(/\/$/, ''),
      localModel: env.LOCAL_STT_MODEL,
      localTimeoutMs: env.LOCAL_STT_TIMEOUT_MS,
      configured:
        env.STT_PROVIDER === 'groq'
          ? env.GROQ_API_KEY.trim().length > 0
          : env.LOCAL_STT_BASE_URL.trim().length > 0,
    },
    reasoning: {
      provider: env.REASONING_PROVIDER,
    },
    groq: {
      apiKey: env.GROQ_API_KEY,
      sttModel: env.GROQ_STT_MODEL,
      llmBaseUrl: env.GROQ_LLM_BASE_URL.replace(/\/$/, ''),
      llmModel: env.GROQ_LLM_MODEL,
      llmTimeoutMs: env.GROQ_LLM_TIMEOUT_MS,
      llmMaxTokens: env.GROQ_LLM_MAX_TOKENS,
      configured: env.GROQ_API_KEY.trim().length > 0,
    },
    tts: {
      provider: env.TTS_PROVIDER,
      enabled: env.TTS_ENABLED,
      model:
        env.TTS_PROVIDER === 'groq' ? env.GROQ_TTS_MODEL : env.LOCAL_TTS_MODEL,
      voice:
        env.TTS_PROVIDER === 'groq' ? env.GROQ_TTS_VOICE : env.LOCAL_TTS_VOICE,
      responseFormat: env.GROQ_TTS_RESPONSE_FORMAT,
      maxChars: env.GROQ_TTS_MAX_CHARS,
      timeoutMs:
        env.TTS_PROVIDER === 'groq'
          ? env.GROQ_TTS_TIMEOUT_MS
          : env.LOCAL_TTS_TIMEOUT_MS,
      playbackMode: env.TTS_PLAYBACK_MODE,
      concurrency: env.TTS_CONCURRENCY,
      cacheEnabled: env.TTS_CACHE_ENABLED,
      estimatedPricePerMillionChars:
        env.TTS_PROVIDER === 'groq'
          ? env.TTS_ESTIMATED_PRICE_PER_MILLION_CHARS
          : 0,
      localBaseUrl: env.LOCAL_TTS_BASE_URL.replace(/\/$/, ''),
      localSpeed: env.LOCAL_TTS_SPEED,
      configured:
        env.TTS_ENABLED &&
        (env.TTS_PROVIDER === 'groq'
          ? env.GROQ_API_KEY.trim().length > 0
          : env.LOCAL_TTS_BASE_URL.trim().length > 0),
    },
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
      model: env.OLLAMA_MODEL,
      requestTimeoutMs: env.OLLAMA_REQUEST_TIMEOUT_MS,
      healthTimeoutMs: env.OLLAMA_HEALTH_TIMEOUT_MS,
      configured:
        env.OLLAMA_BASE_URL.trim().length > 0 &&
        env.OLLAMA_MODEL.trim().length > 0,
    },
  };
}

export const appConfigProvider = {
  provide: APP_CONFIG,
  useFactory: loadAppConfig,
};
