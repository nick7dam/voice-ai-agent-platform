import { Module } from '@nestjs/common';
import {
  APP_CONFIG,
  STT_ADAPTER,
} from '../../common/constants/injection-tokens';
import type { AppConfig } from '../../config/app.config';
import { GroqWhisperAdapter } from './groq-whisper.adapter';
import { LocalWhisperAdapter } from './local-whisper.adapter';
import { SttService } from './stt.service';

@Module({
  providers: [
    SttService,
    GroqWhisperAdapter,
    LocalWhisperAdapter,
    {
      provide: STT_ADAPTER,
      inject: [APP_CONFIG, GroqWhisperAdapter, LocalWhisperAdapter],
      useFactory: (
        config: AppConfig,
        groq: GroqWhisperAdapter,
        local: LocalWhisperAdapter,
      ) => (config.stt.provider === 'groq' ? groq : local),
    },
  ],
  exports: [SttService],
})
export class SttModule {}
