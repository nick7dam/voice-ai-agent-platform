import { APP_CONFIG } from '../common/constants/injection-tokens';
import { envSchema } from './env.schema';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  wsPath: string;
  defaultTaskKey: string;
  taskConfigPath: string;
  ollama: {
    baseUrl: string;
    model: string;
    requestTimeoutMs: number;
    healthTimeoutMs: number;
    numPredict: number;
    numCtx: number;
    keepAlive: string;
    think: boolean;
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
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
      model: env.OLLAMA_MODEL,
      requestTimeoutMs: env.OLLAMA_REQUEST_TIMEOUT_MS,
      healthTimeoutMs: env.OLLAMA_HEALTH_TIMEOUT_MS,
      numPredict: env.OLLAMA_NUM_PREDICT,
      numCtx: env.OLLAMA_NUM_CTX,
      keepAlive: env.OLLAMA_KEEP_ALIVE,
      think: env.OLLAMA_THINK,
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
