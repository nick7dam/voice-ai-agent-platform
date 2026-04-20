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
        provider: 'faster_whisper',
        model: 'Systran/faster-distil-whisper-large-v3',
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
        provider: 'chatterbox_turbo',
        model: 'ResembleAI/chatterbox-turbo',
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
