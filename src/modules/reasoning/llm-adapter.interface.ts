import {
  LlmRequest,
  LlmResponse,
  LlmStreamCallbacks,
} from '../../common/types/reasoning.types';

export interface LlmAdapter {
  generate(input: LlmRequest): Promise<LlmResponse>;
  stream?(
    input: LlmRequest,
    callbacks: LlmStreamCallbacks,
  ): Promise<LlmResponse>;
}
