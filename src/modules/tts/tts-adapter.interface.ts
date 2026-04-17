import {
  TtsAudioResult,
  TtsAudioStreamChunk,
  TtsAudioStreamResult,
  TtsSynthesisInput,
} from '../../common/types/tts.types';

export interface TtsAdapter {
  synthesize(input: TtsSynthesisInput): Promise<TtsAudioResult>;
  stream?(
    input: TtsSynthesisInput,
    callbacks: {
      onChunk: (chunk: TtsAudioStreamChunk) => void | Promise<void>;
    },
  ): Promise<TtsAudioStreamResult>;
}
