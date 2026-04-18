import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  APP_CONFIG,
  TTS_ADAPTER,
} from '../../common/constants/injection-tokens';
import {
  TtsAudioResult,
  TtsAudioStreamChunk,
  TtsAudioStreamResult,
  TtsSegment,
  TtsSynthesisInput,
} from '../../common/types/tts.types';
import type { AppConfig } from '../../config/app.config';
import type { TtsAdapter } from './tts-adapter.interface';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private readonly cache = new Map<string, TtsAudioResult>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TTS_ADAPTER) private readonly adapter: TtsAdapter,
  ) {}

  isEnabled(): boolean {
    return this.config.tts.enabled;
  }

  getMetadata(): { model: string; voice: string; format: string } {
    return {
      model: this.config.tts.model,
      voice: this.config.tts.voice,
      format: this.config.tts.responseFormat,
    };
  }

  getConcurrency(): number {
    return this.config.tts.concurrency;
  }

  shouldEmitEarlyAudio(): boolean {
    return this.config.tts.playbackMode !== 'full';
  }

  shouldStreamPhrases(): boolean {
    return this.config.tts.playbackMode === 'streaming_phrases';
  }

  canStreamAudio(): boolean {
    return typeof this.adapter.stream === 'function';
  }

  splitText(text: string): TtsSegment[] {
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return [];
    }

    const maxChars = this.maxCharsForCurrentProvider();
    const textForSpeech = this.selectTextForSpeech(normalized, maxChars);

    if (this.canStreamAudio()) {
      const chunks = this.splitLongText(textForSpeech, maxChars);
      return chunks.map((chunk, index) => ({
        index,
        total: chunks.length,
        text: chunk,
      }));
    }

    const sentences = textForSpeech.match(/[^.!?]+[.!?]*/g) ?? [textForSpeech];
    const chunks: string[] = [];
    let current = '';

    for (const sentence of sentences
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (!current) {
        current = sentence;
      } else if (`${current} ${sentence}`.length <= maxChars) {
        current = `${current} ${sentence}`;
      } else {
        chunks.push(...this.splitLongText(current, maxChars));
        current = sentence;
      }
    }

    if (current) {
      chunks.push(...this.splitLongText(current, maxChars));
    }

    return chunks.map((chunk, index) => ({
      index,
      total: chunks.length,
      text: chunk,
    }));
  }

  private maxCharsForCurrentProvider(): number {
    return this.canStreamAudio()
      ? Math.max(this.config.tts.maxChars, 450)
      : this.config.tts.maxChars;
  }

  private selectTextForSpeech(text: string, maxChars: number): string {
    if (
      this.config.tts.playbackMode === 'full' ||
      this.config.tts.playbackMode === 'streaming_phrases'
    ) {
      return text;
    }

    if (this.config.tts.playbackMode === 'first_segment') {
      return this.splitLongText(text, maxChars)[0] ?? '';
    }

    const firstSentence = text.match(/[^.!?]+[.!?]*/)?.[0]?.trim() ?? text;
    return this.splitLongText(firstSentence, maxChars)[0] ?? '';
  }

  async synthesizeSegment(segment: TtsSegment): Promise<TtsAudioResult> {
    const input: TtsSynthesisInput = {
      text: segment.text,
      segmentIndex: segment.index,
      segmentTotal: segment.total,
    };
    const cacheKey = this.cacheKey(segment.text);
    const cached = this.config.tts.cacheEnabled
      ? this.cache.get(cacheKey)
      : undefined;

    if (cached) {
      this.logger.log(
        `tts.cache.hit model=${this.config.tts.model} voice=${this.config.tts.voice} chars=${segment.text.length}`,
      );
      return {
        ...cached,
        audio: Buffer.from(cached.audio),
        latencyMs: 0,
        segmentIndex: segment.index,
        segmentTotal: segment.total,
      };
    }

    const result = await this.adapter.synthesize(input);
    const estimatedUsd =
      (segment.text.length / 1_000_000) *
      this.config.tts.estimatedPricePerMillionChars;

    this.logger.log(
      `tts.cost model=${this.config.tts.model} voice=${this.config.tts.voice} chars=${segment.text.length} estimatedUsd=${estimatedUsd.toFixed(6)} cache=false`,
    );

    if (this.config.tts.cacheEnabled) {
      this.cache.set(cacheKey, {
        ...result,
        audio: Buffer.from(result.audio),
      });
    }

    return result;
  }

  async streamSegment(
    segment: TtsSegment,
    callbacks: {
      onChunk: (chunk: TtsAudioStreamChunk) => void | Promise<void>;
    },
  ): Promise<TtsAudioStreamResult> {
    if (!this.adapter.stream) {
      throw new Error('The configured TTS adapter does not support streaming.');
    }

    const input: TtsSynthesisInput = {
      text: segment.text,
      segmentIndex: segment.index,
      segmentTotal: segment.total,
    };

    return this.adapter.stream(input, callbacks);
  }

  private cacheKey(text: string): string {
    return [
      this.config.tts.model,
      this.config.tts.voice,
      this.config.tts.responseFormat,
      text,
    ].join('\u0000');
  }

  private splitLongText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) {
      return [text];
    }

    const words = text.split(' ');
    const chunks: string[] = [];
    let current = '';

    for (const word of words) {
      if (!current) {
        current = word;
      } else if (`${current} ${word}`.length <= maxChars) {
        current = `${current} ${word}`;
      } else {
        chunks.push(...this.splitOversizedWord(current, maxChars));
        current = word;
      }
    }

    if (current) {
      chunks.push(...this.splitOversizedWord(current, maxChars));
    }

    return chunks;
  }

  private splitOversizedWord(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) {
      return [text];
    }

    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += maxChars) {
      chunks.push(text.slice(index, index + maxChars));
    }
    return chunks;
  }
}
