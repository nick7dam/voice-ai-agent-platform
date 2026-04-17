export type ProcessingState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'reasoning'
  | 'ended';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface MemoryFact {
  id: string;
  fact: string;
  category?: string;
  createdAt: string;
}

export interface AudioBufferState {
  turnId?: string;
  chunks: Buffer[];
  mimeType: string;
  sampleRate?: number;
  startedAt?: string;
}

export interface SessionState {
  id: string;
  taskKey: string;
  history: ConversationTurn[];
  memory: MemoryFact[];
  recentAssistantResponses: string[];
  audio: AudioBufferState;
  createdAt: string;
  updatedAt: string;
  currentState: ProcessingState;
  turnSequence: number;
  audioOutputEnabled: boolean;
  activeTurnId?: string;
  interruptedTurnIds: string[];
  metadata?: Record<string, unknown>;
}

export interface ConsumedAudioTurn {
  turnId: string;
  audio: Buffer;
  mimeType: string;
  sampleRate?: number;
}
