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
    const sttReachability =
      this.config.stt.provider === 'local_whisper'
        ? await this.checkLocalService(`${this.config.stt.localBaseUrl}/health`)
        : { reachable: false, skipped: true };
    const ollamaReachability =
      this.config.reasoning.provider === 'ollama'
        ? await this.checkOllama()
        : { reachable: false, skipped: true };
    const ttsReachability =
      this.config.tts.enabled && this.config.tts.provider === 'local_kokoro'
        ? await this.checkLocalService(`${this.config.tts.localBaseUrl}/health`)
        : { reachable: false, skipped: true };

    return {
      status: 'ok',
      stt: {
        provider: this.config.stt.provider,
        configured: this.config.stt.configured,
        reachable: sttReachability.reachable,
        skipped: sttReachability.skipped,
        model:
          this.config.stt.provider === 'groq'
            ? this.config.groq.sttModel
            : this.config.stt.localModel,
        baseUrl:
          this.config.stt.provider === 'local_whisper'
            ? this.config.stt.localBaseUrl
            : undefined,
        error: sttReachability.error,
      },
      reasoning: {
        provider: this.config.reasoning.provider,
        model:
          this.config.reasoning.provider === 'groq'
            ? this.config.groq.llmModel
            : this.config.ollama.model,
        configured:
          this.config.reasoning.provider === 'groq'
            ? this.config.groq.configured
            : this.config.ollama.configured,
      },
      ollama: {
        configured: this.config.ollama.configured,
        reachable: ollamaReachability.reachable,
        skipped: ollamaReachability.skipped,
        baseUrl: this.config.ollama.baseUrl,
        model: this.config.ollama.model,
        error: ollamaReachability.error,
      },
      groq: {
        configured: this.config.groq.configured,
        sttModel: this.config.groq.sttModel,
        llmModel: this.config.groq.llmModel,
        llmBaseUrl: this.config.groq.llmBaseUrl,
        llmMaxTokens: this.config.groq.llmMaxTokens,
      },
      tts: {
        provider: this.config.tts.provider,
        enabled: this.config.tts.enabled,
        configured: this.config.tts.configured,
        reachable: ttsReachability.reachable,
        skipped: ttsReachability.skipped,
        model: this.config.tts.model,
        voice: this.config.tts.voice,
        format: this.config.tts.responseFormat,
        baseUrl:
          this.config.tts.provider === 'local_kokoro'
            ? this.config.tts.localBaseUrl
            : undefined,
        cacheEnabled: this.config.tts.cacheEnabled,
        estimatedPricePerMillionChars:
          this.config.tts.estimatedPricePerMillionChars,
        error: ttsReachability.error,
      },
    };
  }

  private async checkOllama(): Promise<{
    reachable: boolean;
    skipped?: boolean;
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

  private async checkLocalService(url: string): Promise<{
    reachable: boolean;
    skipped?: boolean;
    error?: unknown;
  }> {
    try {
      const response = await requestText(url, {
        timeoutMs: 1500,
      });

      return response.status >= 200 && response.status < 300
        ? { reachable: true }
        : {
            reachable: false,
            error: `Local service returned HTTP ${response.status}.`,
          };
    } catch (error) {
      return {
        reachable: false,
        error:
          error instanceof Error
            ? describeNetworkError(error)
            : 'Unknown local service health check error.',
      };
    }
  }
}
