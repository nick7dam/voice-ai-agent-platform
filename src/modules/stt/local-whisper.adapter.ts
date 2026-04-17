import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  AudioTurnInput,
  TranscriptionResult,
} from '../../common/types/stt.types';
import { requestText } from '../../common/utils/http-client';
import { describeNetworkError } from '../../common/utils/network-error';
import { elapsedMs } from '../../common/utils/timing';
import type { AppConfig } from '../../config/app.config';
import type { SttAdapter } from './stt-adapter.interface';

interface LocalWhisperResponse {
  text?: string;
  language?: string;
  durationSeconds?: number;
  model?: string;
  latencyMs?: number;
}

@Injectable()
export class LocalWhisperAdapter implements SttAdapter {
  private readonly logger = new Logger(LocalWhisperAdapter.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async transcribe(input: AudioTurnInput): Promise<TranscriptionResult> {
    if (!this.config.stt.configured) {
      throw new AppError(
        'LOCAL_STT_NOT_CONFIGURED',
        'Local Whisper STT is not configured. Set LOCAL_STT_BASE_URL or use STT_PROVIDER=groq.',
      );
    }

    const startedAt = process.hrtime.bigint();

    try {
      this.logger.log(
        `transcription.local.start session=${input.sessionId} turn=${input.turnId} bytes=${input.audio.byteLength}`,
      );

      const response = await requestText(
        `${this.config.stt.localBaseUrl}/transcribe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audioBase64: input.audio.toString('base64'),
            mimeType: input.mimeType,
            sampleRate: input.sampleRate,
            sessionId: input.sessionId,
            turnId: input.turnId,
          }),
          timeoutMs: this.config.stt.localTimeoutMs,
        },
      );

      if (response.status < 200 || response.status >= 300) {
        throw new AppError(
          'LOCAL_STT_FAILED',
          'Local Whisper transcription failed.',
          {
            status: response.status,
            body: response.body.slice(0, 1000),
          },
        );
      }

      const parsed = JSON.parse(response.body) as LocalWhisperResponse;
      const latencyMs = elapsedMs(startedAt);

      this.logger.log(
        `transcription.local.end session=${input.sessionId} turn=${input.turnId} latencyMs=${latencyMs} providerLatencyMs=${parsed.latencyMs ?? 'unknown'}`,
      );

      return {
        text: parsed.text?.trim() ?? '',
        language: parsed.language,
        durationSeconds: parsed.durationSeconds,
        provider: 'local_whisper',
        model: parsed.model ?? this.config.stt.localModel,
        latencyMs,
        raw: parsed,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        'LOCAL_STT_CONNECTION_FAILED',
        `Could not reach local Whisper STT at ${this.config.stt.localBaseUrl}. Start services/local-ai/stt_server.py or set STT_PROVIDER=groq.`,
        {
          baseUrl: this.config.stt.localBaseUrl,
          model: this.config.stt.localModel,
          timeoutMs: this.config.stt.localTimeoutMs,
          networkError: describeNetworkError(error),
        },
      );
    }
  }
}
