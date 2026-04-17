import { Module } from '@nestjs/common';
import {
  APP_CONFIG,
  LLM_ADAPTER,
} from '../../common/constants/injection-tokens';
import type { AppConfig } from '../../config/app.config';
import { GroqChatAdapter } from './groq-chat.adapter';
import { OllamaAdapter } from './ollama.adapter';
import { ReasoningService } from './reasoning.service';

@Module({
  providers: [
    ReasoningService,
    GroqChatAdapter,
    OllamaAdapter,
    {
      provide: LLM_ADAPTER,
      inject: [APP_CONFIG, GroqChatAdapter, OllamaAdapter],
      useFactory: (
        config: AppConfig,
        groq: GroqChatAdapter,
        ollama: OllamaAdapter,
      ) => (config.reasoning.provider === 'ollama' ? ollama : groq),
    },
  ],
  exports: [ReasoningService],
})
export class ReasoningModule {}
