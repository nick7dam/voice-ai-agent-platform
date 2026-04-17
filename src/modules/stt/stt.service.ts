import { Inject, Injectable } from '@nestjs/common';
import { STT_ADAPTER } from '../../common/constants/injection-tokens';
import {
  AudioTurnInput,
  TranscriptionResult,
} from '../../common/types/stt.types';
import type { SttAdapter } from './stt-adapter.interface';

@Injectable()
export class SttService {
  constructor(@Inject(STT_ADAPTER) private readonly adapter: SttAdapter) {}

  async transcribeTurn(input: AudioTurnInput): Promise<TranscriptionResult> {
    // Future hook: replace buffered-turn transcription with partial streaming STT
    // while preserving this normalized result for final transcripts.
    return this.adapter.transcribe(input);
  }
}
