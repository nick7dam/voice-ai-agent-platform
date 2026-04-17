import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  ChatMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamCallbacks,
} from '../../common/types/reasoning.types';
import { ToolCall } from '../../common/types/tool.types';
import { elapsedMs } from '../../common/utils/timing';
import { describeNetworkError } from '../../common/utils/network-error';
import {
  HttpTextResponse,
  requestText,
  requestTextStream,
} from '../../common/utils/http-client';
import type { AppConfig } from '../../config/app.config';
import type { LlmAdapter } from './llm-adapter.interface';

interface OllamaMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: unknown;
    };
  }>;
}

interface OllamaResponse {
  model?: string;
  message?: OllamaMessage;
  response?: string;
  done?: boolean;
}

interface OllamaStreamChunk extends OllamaResponse {
  done_reason?: string;
}

@Injectable()
export class OllamaAdapter implements LlmAdapter {
  private readonly logger = new Logger(OllamaAdapter.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async generate(input: LlmRequest): Promise<LlmResponse> {
    if (!this.config.ollama.configured) {
      throw new AppError(
        'OLLAMA_NOT_CONFIGURED',
        'Ollama is not configured. Set OLLAMA_BASE_URL and OLLAMA_MODEL.',
      );
    }

    const startedAt = process.hrtime.bigint();

    // Future hook: set stream=true and surface token deltas through the same
    // gateway event emitter when the UI needs partial assistant output.
    const response = await this.postChat(input);

    const rawText = response.body;

    if (response.status < 200 || response.status >= 300) {
      throw new AppError('OLLAMA_REQUEST_FAILED', 'Ollama generation failed.', {
        status: response.status,
        body: rawText.slice(0, 1000),
      });
    }

    const parsed = JSON.parse(rawText) as OllamaResponse;
    const latencyMs = elapsedMs(startedAt);
    const toolCalls = this.normalizeToolCalls(parsed.message?.tool_calls);
    const text = parsed.message?.content ?? parsed.response ?? '';

    this.logger.log(
      `reasoning.ollama.end model=${parsed.model ?? this.config.ollama.model} latencyMs=${latencyMs} toolCalls=${toolCalls.length}`,
    );

    return {
      text,
      toolCalls,
      model: parsed.model ?? this.config.ollama.model,
      latencyMs,
      raw: parsed,
    };
  }

  async stream(
    input: LlmRequest,
    callbacks: LlmStreamCallbacks,
  ): Promise<LlmResponse> {
    if (!this.config.ollama.configured) {
      throw new AppError(
        'OLLAMA_NOT_CONFIGURED',
        'Ollama is not configured. Set OLLAMA_BASE_URL and OLLAMA_MODEL.',
      );
    }

    const startedAt = process.hrtime.bigint();
    const chunks: OllamaStreamChunk[] = [];
    let lineBuffer = '';
    let text = '';
    let model = this.config.ollama.model;

    const response = await this.postChatStream(input, (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = this.parseStreamLine(line);
        if (!parsed) {
          continue;
        }

        chunks.push(parsed);
        model = parsed.model ?? model;

        const delta = parsed.message?.content ?? parsed.response ?? '';
        if (!delta) {
          continue;
        }

        text += delta;
        const result = callbacks.onTextDelta?.(delta);

        if (result instanceof Promise) {
          void result.catch((error: unknown) => {
            this.logger.warn(
              `reasoning.ollama.stream.callback_error message=${error instanceof Error ? error.message : 'unknown'}`,
            );
          });
        }
      }
    });

    const trailing = this.parseStreamLine(lineBuffer);
    if (trailing) {
      chunks.push(trailing);
      model = trailing.model ?? model;
      const delta = trailing.message?.content ?? trailing.response ?? '';
      if (delta) {
        text += delta;
      }
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AppError('OLLAMA_REQUEST_FAILED', 'Ollama generation failed.', {
        status: response.status,
        body: response.body.slice(0, 1000),
      });
    }

    const latencyMs = elapsedMs(startedAt);
    this.logger.log(
      `reasoning.ollama.stream.end model=${model} latencyMs=${latencyMs} chars=${text.length}`,
    );

    return {
      text,
      toolCalls: [],
      model,
      latencyMs,
      raw: chunks,
    };
  }

  private async postChat(input: LlmRequest): Promise<HttpTextResponse> {
    try {
      return await requestText(`${this.config.ollama.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ollama.model,
          messages: input.messages.map((message) =>
            this.toOllamaMessage(message),
          ),
          tools: input.tools,
          stream: false,
          think: this.config.ollama.think,
          keep_alive: this.config.ollama.keepAlive,
          options: {
            temperature: input.temperature ?? 0.2,
            num_predict: input.maxTokens ?? this.config.ollama.numPredict,
            num_ctx: this.config.ollama.numCtx,
          },
        }),
        timeoutMs: this.config.ollama.requestTimeoutMs,
      });
    } catch (error) {
      const networkError = describeNetworkError(error);
      throw new AppError(
        'OLLAMA_CONNECTION_FAILED',
        `Could not complete the Ollama request to ${this.config.ollama.baseUrl} within ${this.config.ollama.requestTimeoutMs}ms. Increase OLLAMA_REQUEST_TIMEOUT_MS if the remote model needs longer.`,
        {
          baseUrl: this.config.ollama.baseUrl,
          model: this.config.ollama.model,
          timeoutMs: this.config.ollama.requestTimeoutMs,
          networkError,
        },
      );
    }
  }

  private async postChatStream(
    input: LlmRequest,
    onChunk: (chunk: string) => void,
  ): Promise<HttpTextResponse> {
    try {
      return await requestTextStream(`${this.config.ollama.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ollama.model,
          messages: input.messages.map((message) =>
            this.toOllamaMessage(message),
          ),
          stream: true,
          think: this.config.ollama.think,
          keep_alive: this.config.ollama.keepAlive,
          options: {
            temperature: input.temperature ?? 0.2,
            num_predict: input.maxTokens ?? this.config.ollama.numPredict,
            num_ctx: this.config.ollama.numCtx,
          },
        }),
        timeoutMs: this.config.ollama.requestTimeoutMs,
        onChunk,
      });
    } catch (error) {
      const networkError = describeNetworkError(error);
      throw new AppError(
        'OLLAMA_CONNECTION_FAILED',
        `Could not complete the Ollama stream to ${this.config.ollama.baseUrl} within ${this.config.ollama.requestTimeoutMs}ms. Increase OLLAMA_REQUEST_TIMEOUT_MS if the remote model needs longer.`,
        {
          baseUrl: this.config.ollama.baseUrl,
          model: this.config.ollama.model,
          timeoutMs: this.config.ollama.requestTimeoutMs,
          networkError,
        },
      );
    }
  }

  private toOllamaMessage(message: ChatMessage): OllamaMessage {
    const output: OllamaMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      output.name = message.name;
    }

    if (message.toolCallId) {
      output.tool_call_id = message.toolCallId;
    }

    if (message.toolCalls?.length) {
      output.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }));
    }

    return output;
  }

  private normalizeToolCalls(
    toolCalls?: OllamaMessage['tool_calls'],
  ): ToolCall[] {
    if (!toolCalls?.length) {
      return [];
    }

    return toolCalls
      .map((toolCall) => {
        const name = toolCall.function?.name;
        if (!name) {
          return undefined;
        }

        return {
          id: toolCall.id ?? randomUUID(),
          name,
          arguments: this.normalizeArguments(toolCall.function?.arguments),
        };
      })
      .filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
  }

  private normalizeArguments(args: unknown): unknown {
    if (typeof args !== 'string') {
      return args ?? {};
    }

    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }

  private parseStreamLine(line: string): OllamaStreamChunk | undefined {
    const trimmed = line.trim();

    if (!trimmed) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed) as OllamaStreamChunk;
    } catch {
      throw new AppError(
        'OLLAMA_BAD_STREAM_CHUNK',
        'Ollama returned a malformed streaming chat chunk.',
        {
          body: trimmed.slice(0, 1000),
        },
      );
    }
  }
}
