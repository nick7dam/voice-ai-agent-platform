import { z } from 'zod';

export interface ToolJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolExecutionContext {
  sessionId: string;
  turnId: string;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  parameters: ToolJsonSchema;
  execute(input: TInput, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface NormalizedToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  latencyMs: number;
}

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
  };
}
