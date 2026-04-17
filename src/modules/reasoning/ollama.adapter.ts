import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  ChatMessage,
  LlmRequest,
  LlmResponse,
} from '../../common/types/reasoning.types';
import { ToolCall } from '../../common/types/tool.types';
import { elapsedMs } from '../../common/utils/timing';
import { describeNetworkError } from '../../common/utils/network-error';
import { HttpTextResponse, requestText } from '../../common/utils/http-client';
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
          options: {
            temperature: input.temperature ?? 0.2,
            num_predict: input.maxTokens,
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
}
