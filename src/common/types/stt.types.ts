export interface AudioTurnInput {
  sessionId: string;
  turnId: string;
  audio: Buffer;
  mimeType: string;
  sampleRate?: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  provider: string;
  model: string;
  latencyMs: number;
  raw?: unknown;
}
