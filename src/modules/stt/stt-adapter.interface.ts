import {
  AudioTurnInput,
  TranscriptionResult,
} from '../../common/types/stt.types';

export interface SttAdapter {
  transcribe(input: AudioTurnInput): Promise<TranscriptionResult>;
}
