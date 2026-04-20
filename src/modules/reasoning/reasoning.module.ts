import { Module } from '@nestjs/common';
import { LLM_ADAPTER } from '../../common/constants/injection-tokens';
import { OllamaAdapter } from './ollama.adapter';
import { ReasoningService } from './reasoning.service';

@Module({
  providers: [
    ReasoningService,
    OllamaAdapter,
    {
      provide: LLM_ADAPTER,
      useExisting: OllamaAdapter,
    },
  ],
  exports: [ReasoningService],
})
export class ReasoningModule {}
