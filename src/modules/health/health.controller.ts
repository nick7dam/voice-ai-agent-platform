import { Controller, Get, Inject } from '@nestjs/common';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { requestText } from '../../common/utils/http-client';
import { describeNetworkError } from '../../common/utils/network-error';
import type { AppConfig } from '../../config/app.config';

@Controller('health')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  async getHealth() {
    const ollamaReachability = await this.checkOllama();

    return {
      status: 'ok',
      transport: {
        browser: 'webrtc',
        gateway: 'services/local-ai/webrtc_voice_gateway.py',
        controlWebSocketPath: this.config.wsPath,
      },
      stt: {
        provider: process.env.LOCAL_STT_BACKEND ?? 'qwen_asr',
        model:
          process.env.LOCAL_STT_MODEL ??
          'Qwen/Qwen3-ASR-0.6B',
        location: 'webrtc_voice_gateway',
      },
      reasoning: {
        provider: 'ollama',
        model: this.config.ollama.model,
        configured: this.config.ollama.configured,
        reachable: ollamaReachability.reachable,
        baseUrl: this.config.ollama.baseUrl,
        error: ollamaReachability.error,
      },
      tts: {
        provider: 'qwen3_tts',
        model:
          process.env.LOCAL_QWEN_TTS_MODEL ??
          'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
        speaker: process.env.LOCAL_QWEN_TTS_SPEAKER ?? 'Aiden',
        streamingChunkSize: process.env.LOCAL_QWEN_TTS_STREAM_CHUNK_SIZE ?? '4',
        location: 'webrtc_voice_gateway',
      },
    };
  }

  private async checkOllama(): Promise<{
    reachable: boolean;
    error?: unknown;
  }> {
    if (!this.config.ollama.configured) {
      return {
        reachable: false,
        error: 'OLLAMA_BASE_URL or OLLAMA_MODEL is not configured.',
      };
    }

    try {
      const response = await requestText(
        `${this.config.ollama.baseUrl}/api/tags`,
        {
          timeoutMs: this.config.ollama.healthTimeoutMs,
        },
      );

      return response.status >= 200 && response.status < 300
        ? { reachable: true }
        : {
            reachable: false,
            error: `Ollama returned HTTP ${response.status}.`,
          };
    } catch (error) {
      return {
        reachable: false,
        error:
          error instanceof Error
            ? describeNetworkError(error)
            : 'Unknown Ollama health check error.',
      };
    }
  }
}
