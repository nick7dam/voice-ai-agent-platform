import { Inject, Injectable } from '@nestjs/common';
import { LLM_ADAPTER } from '../../common/constants/injection-tokens';
import {
  LlmRequest,
  LlmResponse,
  LlmStreamCallbacks,
} from '../../common/types/reasoning.types';
import type { LlmAdapter } from './llm-adapter.interface';

@Injectable()
export class ReasoningService {
  constructor(@Inject(LLM_ADAPTER) private readonly adapter: LlmAdapter) {}

  async generate(input: LlmRequest): Promise<LlmResponse> {
    return this.adapter.generate(input);
  }

  async stream(
    input: LlmRequest,
    callbacks: LlmStreamCallbacks,
  ): Promise<LlmResponse> {
    if (!this.adapter.stream) {
      return this.adapter.generate(input);
    }

    return this.adapter.stream(input, callbacks);
  }
}
