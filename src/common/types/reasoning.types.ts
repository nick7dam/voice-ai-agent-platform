import { LlmToolDefinition, ToolCall } from './tool.types';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  latencyMs: number;
  raw?: unknown;
}

export interface LlmStreamCallbacks {
  onTextDelta?: (delta: string) => void | Promise<void>;
}
