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

export interface TtsAudioStreamChunk {
  audio: Buffer;
  mimeType: string;
  encoding: 'pcm_s16le';
  sampleRate: number;
  model: string;
  voice: string;
  format: string;
  latencyMs: number;
  chunkIndex: number;
  segmentIndex: number;
  segmentTotal: number;
}

export interface TtsAudioStreamResult {
  model: string;
  voice: string;
  format: string;
  latencyMs: number;
  chunkCount: number;
  byteLength: number;
  segmentIndex: number;
  segmentTotal: number;
}
