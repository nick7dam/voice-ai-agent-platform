export interface TtsSegment {
  index: number;
  total: number;
  text: string;
}

export interface TtsSynthesisInput {
  text: string;
  segmentIndex: number;
  segmentTotal: number;
}

export interface TtsAudioResult {
  audio: Buffer;
  mimeType: string;
  model: string;
  voice: string;
  format: string;
  latencyMs: number;
  segmentIndex: number;
  segmentTotal: number;
}
