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
  turnId?: string;
}

export interface InterruptedAssistantTurn {
  turnId: string;
  text: string;
  reason?: string;
  at: string;
  finalized: boolean;
}

export interface SessionState {
  id: string;
  taskKey: string;
  history: ConversationTurn[];
  recentAssistantResponses: string[];
  createdAt: string;
  updatedAt: string;
  currentState: ProcessingState;
  turnSequence: number;
  activeTurnId?: string;
  interruptedTurnIds: string[];
  assistantDraftTurn?: {
    turnId: string;
    text: string;
    finalized: boolean;
    updatedAt: string;
  };
  interruptedAssistantTurn?: InterruptedAssistantTurn;
  metadata?: Record<string, unknown>;
}
