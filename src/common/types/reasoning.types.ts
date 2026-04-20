export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  latencyMs: number;
  raw?: unknown;
}

export interface LlmStreamCallbacks {
  onTextDelta?: (delta: string) => void | Promise<void>;
}
