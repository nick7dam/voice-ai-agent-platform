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
export class GroqTtsAdapter implements TtsAdapter {
  private readonly logger = new Logger(GroqTtsAdapter.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async synthesize(input: TtsSynthesisInput): Promise<TtsAudioResult> {
    if (!this.config.groq.configured) {
      throw new AppError(
        'GROQ_TTS_NOT_CONFIGURED',
        'GROQ_API_KEY is required when TTS_ENABLED=true.',
      );
    }

    const startedAt = process.hrtime.bigint();

    try {
      const response = await requestBuffer(
        'https://api.groq.com/openai/v1/audio/speech',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.groq.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'audio/wav',
          },
          body: JSON.stringify({
            model: this.config.tts.model,
            input: input.text,
            voice: this.config.tts.voice,
            response_format: this.config.tts.responseFormat,
          }),
          timeoutMs: this.config.tts.timeoutMs,
        },
      );

      if (response.status < 200 || response.status >= 300) {
        throw new AppError('GROQ_TTS_FAILED', 'Groq TTS request failed.', {
          status: response.status,
          body: response.body.toString('utf8').slice(0, 1000),
        });
      }

      const latencyMs = elapsedMs(startedAt);
      this.logger.log(
        `tts.groq.end model=${this.config.tts.model} voice=${this.config.tts.voice} segment=${input.segmentIndex + 1}/${input.segmentTotal} latencyMs=${latencyMs}`,
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
        'GROQ_TTS_CONNECTION_FAILED',
        `Could not complete Groq TTS within ${this.config.tts.timeoutMs}ms.`,
        {
          model: this.config.tts.model,
          voice: this.config.tts.voice,
          timeoutMs: this.config.tts.timeoutMs,
          networkError: describeNetworkError(error),
        },
      );
    }
  }
}
