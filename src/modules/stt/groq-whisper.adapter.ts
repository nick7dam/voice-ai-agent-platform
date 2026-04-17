import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  AudioTurnInput,
  TranscriptionResult,
} from '../../common/types/stt.types';
import { elapsedMs } from '../../common/utils/timing';
import type { AppConfig } from '../../config/app.config';
import type { SttAdapter } from './stt-adapter.interface';

interface GroqTranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
}

@Injectable()
export class GroqWhisperAdapter implements SttAdapter {
  private readonly logger = new Logger(GroqWhisperAdapter.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async transcribe(input: AudioTurnInput): Promise<TranscriptionResult> {
    if (!this.config.groq.configured) {
      throw new AppError(
        'GROQ_NOT_CONFIGURED',
        'GROQ_API_KEY is not configured. Add it to .env before sending audio.',
      );
    }

    const startedAt = process.hrtime.bigint();
    const form = new FormData();
    const bytes = Uint8Array.from(input.audio);
    const fileName = `turn-${input.turnId}.${this.extensionForMime(input.mimeType)}`;

    form.append(
      'file',
      new Blob([bytes.buffer], { type: input.mimeType }),
      fileName,
    );
    form.append('model', this.config.groq.sttModel);
    form.append('response_format', 'json');

    this.logger.log(
      `transcription.start session=${input.sessionId} turn=${input.turnId} bytes=${input.audio.byteLength}`,
    );

    const response = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.groq.apiKey}`,
        },
        body: form,
      },
    );

    const rawText = await response.text();

    if (!response.ok) {
      throw new AppError(
        'GROQ_STT_FAILED',
        'Groq Whisper transcription failed.',
        {
          status: response.status,
          body: rawText.slice(0, 1000),
        },
      );
    }

    const parsed = JSON.parse(rawText) as GroqTranscriptionResponse;
    const latencyMs = elapsedMs(startedAt);
    this.logger.log(
      `transcription.end session=${input.sessionId} turn=${input.turnId} latencyMs=${latencyMs}`,
    );

    return {
      text: parsed.text?.trim() ?? '',
      language: parsed.language,
      durationSeconds: parsed.duration,
      provider: 'groq',
      model: this.config.groq.sttModel,
      latencyMs,
      raw: parsed,
    };
  }

  private extensionForMime(mimeType: string): string {
    if (mimeType.includes('wav')) {
      return 'wav';
    }
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
      return 'mp3';
    }
    if (mimeType.includes('ogg')) {
      return 'ogg';
    }
    if (mimeType.includes('mp4')) {
      return 'mp4';
    }
    return 'webm';
  }
}
