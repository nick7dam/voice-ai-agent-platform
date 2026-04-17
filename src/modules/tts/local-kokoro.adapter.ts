import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  TtsAudioResult,
  TtsSynthesisInput,
} from '../../common/types/tts.types';
import { requestBuffer } from '../../common/utils/http-client';
import { describeNetworkError } from '../../common/utils/network-error';
import { elapsedMs } from '../../common/utils/timing';
import type { AppConfig } from '../../config/app.config';
import type { TtsAdapter } from './tts-adapter.interface';

@Injectable()
export class LocalKokoroAdapter implements TtsAdapter {
  private readonly logger = new Logger(LocalKokoroAdapter.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async synthesize(input: TtsSynthesisInput): Promise<TtsAudioResult> {
    if (!this.config.tts.configured) {
      throw new AppError(
        'LOCAL_TTS_NOT_CONFIGURED',
        'Local Kokoro TTS is not configured. Set LOCAL_TTS_BASE_URL or use TTS_PROVIDER=groq.',
      );
    }

    const startedAt = process.hrtime.bigint();

    try {
      const response = await requestBuffer(
        `${this.config.tts.localBaseUrl}/synthesize`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'audio/wav',
          },
          body: JSON.stringify({
            text: input.text,
            voice: this.config.tts.voice,
            speed: this.config.tts.localSpeed,
          }),
          timeoutMs: this.config.tts.timeoutMs,
        },
      );

      if (response.status < 200 || response.status >= 300) {
        throw new AppError('LOCAL_TTS_FAILED', 'Local Kokoro TTS failed.', {
          status: response.status,
          body: response.body.toString('utf8').slice(0, 1000),
        });
      }

      const latencyMs = elapsedMs(startedAt);
      this.logger.log(
        `tts.local.end model=${this.config.tts.model} voice=${this.config.tts.voice} segment=${input.segmentIndex + 1}/${input.segmentTotal} chars=${input.text.length} device=${this.headerValue(response.headers['x-device']) ?? 'unknown'} audioSeconds=${this.headerValue(response.headers['x-audio-seconds']) ?? 'unknown'} serverLoadLatencyMs=${this.headerValue(response.headers['x-load-latency-ms']) ?? 'unknown'} serverSynthLatencyMs=${this.headerValue(response.headers['x-synthesis-latency-ms']) ?? 'unknown'} serverEncodeLatencyMs=${this.headerValue(response.headers['x-encode-latency-ms']) ?? 'unknown'} latencyMs=${latencyMs}`,
      );

      return {
        audio: response.body,
        mimeType: 'audio/wav',
        model: this.config.tts.model,
        voice: this.config.tts.voice,
        format: this.config.tts.responseFormat,
        latencyMs,
        segmentIndex: input.segmentIndex,
        segmentTotal: input.segmentTotal,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        'LOCAL_TTS_CONNECTION_FAILED',
        `Could not reach local Kokoro TTS at ${this.config.tts.localBaseUrl}. Start services/local-ai/tts_server.py or set TTS_PROVIDER=groq.`,
        {
          baseUrl: this.config.tts.localBaseUrl,
          model: this.config.tts.model,
          voice: this.config.tts.voice,
          timeoutMs: this.config.tts.timeoutMs,
          networkError: describeNetworkError(error),
        },
      );
    }
  }

  private headerValue(
    value: string | string[] | undefined,
  ): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }
}
