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
import {
  HttpTextResponse,
  requestText,
  requestTextStream,
} from '../../common/utils/http-client';
import { describeNetworkError } from '../../common/utils/network-error';
import { elapsedMs } from '../../common/utils/timing';
import type { AppConfig } from '../../config/app.config';
import type { LlmAdapter } from './llm-adapter.interface';

interface GroqChatMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: GroqToolCall[];
}

interface GroqToolCall {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface GroqChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: GroqChatMessage;
  }>;
}

interface GroqChatStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

@Injectable()
export class GroqChatAdapter implements LlmAdapter {
  private readonly logger = new Logger(GroqChatAdapter.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async generate(input: LlmRequest): Promise<LlmResponse> {
    if (!this.config.groq.configured) {
      throw new AppError(
        'GROQ_LLM_NOT_CONFIGURED',
        'GROQ_API_KEY is required for Groq reasoning. Add it to .env before sending messages.',
      );
    }

    const startedAt = process.hrtime.bigint();
    const response = await this.postChat(input);
    const rawText = response.body;

    if (response.status < 200 || response.status >= 300) {
      throw new AppError('GROQ_LLM_FAILED', 'Groq chat completion failed.', {
        status: response.status,
        body: rawText.slice(0, 1000),
      });
    }

    const parsed = this.parseResponse(rawText);
    const message = parsed.choices?.[0]?.message;
    const latencyMs = elapsedMs(startedAt);
    const toolCalls = this.normalizeToolCalls(message?.tool_calls);

    this.logger.log(
      `reasoning.groq.end model=${parsed.model ?? this.config.groq.llmModel} latencyMs=${latencyMs} toolCalls=${toolCalls.length}`,
    );

    return {
      text: message?.content ?? '',
      toolCalls,
      model: parsed.model ?? this.config.groq.llmModel,
      latencyMs,
      raw: parsed,
    };
  }

  async stream(
    input: LlmRequest,
    callbacks: LlmStreamCallbacks,
  ): Promise<LlmResponse> {
    if (!this.config.groq.configured) {
      throw new AppError(
        'GROQ_LLM_NOT_CONFIGURED',
        'GROQ_API_KEY is required for Groq reasoning. Add it to .env before sending messages.',
      );
    }

    const startedAt = process.hrtime.bigint();
    const chunks: GroqChatStreamChunk[] = [];
    let text = '';
    let sseBuffer = '';
    let model = this.config.groq.llmModel;

    const response = await this.postChatStream(input, (chunk) => {
      sseBuffer += chunk;
      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop() ?? '';

      for (const part of parts) {
        const payload = this.parseSsePayload(part);

        if (!payload || payload === '[DONE]') {
          continue;
        }

        const parsed = this.parseStreamChunk(payload);
        chunks.push(parsed);
        model = parsed.model ?? model;

        const delta = parsed.choices?.[0]?.delta?.content ?? '';

        if (delta) {
          text += delta;
          const result = callbacks.onTextDelta?.(delta);

          if (result instanceof Promise) {
            void result.catch((error: unknown) => {
              this.logger.warn(
                `reasoning.groq.stream.callback_error message=${error instanceof Error ? error.message : 'unknown'}`,
              );
            });
          }
        }
      }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new AppError('GROQ_LLM_FAILED', 'Groq chat completion failed.', {
        status: response.status,
        body: response.body.slice(0, 1000),
      });
    }

    const latencyMs = elapsedMs(startedAt);
    this.logger.log(
      `reasoning.groq.stream.end model=${model} latencyMs=${latencyMs} chars=${text.length}`,
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
      const hasTools = Boolean(input.tools?.length);

      return await requestText(
        `${this.config.groq.llmBaseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.groq.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.groq.llmModel,
            messages: input.messages.map((message) =>
              this.toGroqMessage(message),
            ),
            tools: hasTools ? input.tools : undefined,
            tool_choice: hasTools ? 'auto' : undefined,
            include_reasoning: this.shouldSuppressReasoning()
              ? false
              : undefined,
            stream: false,
            temperature: input.temperature ?? 0.2,
            max_completion_tokens:
              input.maxTokens ?? this.config.groq.llmMaxTokens,
          }),
          timeoutMs: this.config.groq.llmTimeoutMs,
        },
      );
    } catch (error) {
      const networkError = describeNetworkError(error);
      throw new AppError(
        'GROQ_LLM_CONNECTION_FAILED',
        `Could not complete the Groq reasoning request within ${this.config.groq.llmTimeoutMs}ms.`,
        {
          baseUrl: this.config.groq.llmBaseUrl,
          model: this.config.groq.llmModel,
          timeoutMs: this.config.groq.llmTimeoutMs,
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
      return await requestTextStream(
        `${this.config.groq.llmBaseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.groq.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.groq.llmModel,
            messages: input.messages.map((message) =>
              this.toGroqMessage(message),
            ),
            stream: true,
            include_reasoning: this.shouldSuppressReasoning()
              ? false
              : undefined,
            temperature: input.temperature ?? 0.2,
            max_completion_tokens:
              input.maxTokens ?? this.config.groq.llmMaxTokens,
          }),
          timeoutMs: this.config.groq.llmTimeoutMs,
          onChunk,
        },
      );
    } catch (error) {
      const networkError = describeNetworkError(error);
      throw new AppError(
        'GROQ_LLM_CONNECTION_FAILED',
        `Could not complete the Groq reasoning stream within ${this.config.groq.llmTimeoutMs}ms.`,
        {
          baseUrl: this.config.groq.llmBaseUrl,
          model: this.config.groq.llmModel,
          timeoutMs: this.config.groq.llmTimeoutMs,
          networkError,
        },
      );
    }
  }

  private toGroqMessage(message: ChatMessage): GroqChatMessage {
    const output: GroqChatMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.role === 'tool' && message.toolCallId) {
      output.tool_call_id = message.toolCallId;
    }

    if (message.name && message.role !== 'tool') {
      output.name = message.name;
    }

    if (message.toolCalls?.length) {
      output.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: this.stringifyArguments(toolCall.arguments),
        },
      }));
    }

    return output;
  }

  private normalizeToolCalls(toolCalls?: GroqToolCall[]): ToolCall[] {
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

  private stringifyArguments(args: unknown): string {
    if (typeof args === 'string') {
      return args;
    }

    return JSON.stringify(args ?? {});
  }

  private shouldSuppressReasoning(): boolean {
    return this.config.groq.llmModel.startsWith('openai/gpt-oss');
  }

  private parseSsePayload(part: string): string | undefined {
    const dataLines = part
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());

    if (dataLines.length === 0) {
      return undefined;
    }

    return dataLines.join('\n');
  }

  private parseStreamChunk(rawText: string): GroqChatStreamChunk {
    try {
      return JSON.parse(rawText) as GroqChatStreamChunk;
    } catch {
      throw new AppError(
        'GROQ_LLM_BAD_RESPONSE',
        'Groq returned a malformed streaming chat chunk.',
        {
          body: rawText.slice(0, 1000),
        },
      );
    }
  }

  private parseResponse(rawText: string): GroqChatCompletionResponse {
    try {
      return JSON.parse(rawText) as GroqChatCompletionResponse;
    } catch {
      throw new AppError(
        'GROQ_LLM_BAD_RESPONSE',
        'Groq returned a non-JSON chat completion response.',
        {
          body: rawText.slice(0, 1000),
        },
      );
    }
  }
}
