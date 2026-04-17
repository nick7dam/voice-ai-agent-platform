import { Module } from '@nestjs/common';
import {
  APP_CONFIG,
  TTS_ADAPTER,
} from '../../common/constants/injection-tokens';
import type { AppConfig } from '../../config/app.config';
import { GroqTtsAdapter } from './groq-tts.adapter';
import { LocalKokoroAdapter } from './local-kokoro.adapter';
import { TtsService } from './tts.service';

@Module({
  providers: [
    GroqTtsAdapter,
    LocalKokoroAdapter,
    TtsService,
    {
      provide: TTS_ADAPTER,
      inject: [APP_CONFIG, GroqTtsAdapter, LocalKokoroAdapter],
      useFactory: (
        config: AppConfig,
        groq: GroqTtsAdapter,
        local: LocalKokoroAdapter,
      ) => (config.tts.provider === 'groq' ? groq : local),
    },
  ],
  exports: [TtsService],
})
export class TtsModule {}
