import {
  TtsAudioResult,
  TtsSynthesisInput,
} from '../../common/types/tts.types';

export interface TtsAdapter {
  synthesize(input: TtsSynthesisInput): Promise<TtsAudioResult>;
}
