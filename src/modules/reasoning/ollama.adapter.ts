import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  ChatMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamCallbacks,
} from '../../common/types/reasoning.types';
import { describeNetworkError } from '../../common/utils/network-error';
import { elapsedMs } from '../../common/utils/timing';
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
    const response = await this.postChat(input, false);
    const rawText = response.body;

    if (response.status < 200 || response.status >= 300) {
      throw new AppError('OLLAMA_REQUEST_FAILED', 'Ollama generation failed.', {
        status: response.status,
        body: rawText.slice(0, 1000),
      });
    }

    const parsed = JSON.parse(rawText) as OllamaResponse;
    const latencyMs = elapsedMs(startedAt);
    const text = parsed.message?.content ?? parsed.response ?? '';

    this.logger.log(
      `reasoning.ollama.end model=${parsed.model ?? this.config.ollama.model} latencyMs=${latencyMs}`,
    );

    return {
      text,
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
      model,
      latencyMs,
      raw: chunks,
    };
  }

  private async postChat(
    input: LlmRequest,
    stream: boolean,
  ): Promise<HttpTextResponse> {
    try {
      return await requestText(`${this.config.ollama.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.createPayload(input, stream)),
        timeoutMs: this.config.ollama.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw this.connectionError(error, stream);
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
        body: JSON.stringify(this.createPayload(input, true)),
        timeoutMs: this.config.ollama.requestTimeoutMs,
        onChunk,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw this.connectionError(error, true);
    }
  }

  private createPayload(input: LlmRequest, stream: boolean) {
    return {
      model: this.config.ollama.model,
      messages: input.messages.map((message) => this.toOllamaMessage(message)),
      stream,
      think: this.config.ollama.think,
      keep_alive: this.config.ollama.keepAlive,
      options: {
        temperature: input.temperature ?? 0.2,
        num_predict: input.maxTokens ?? this.config.ollama.numPredict,
        num_ctx: this.config.ollama.numCtx,
      },
    };
  }

  private connectionError(error: unknown, stream: boolean): AppError {
    const mode = stream ? 'stream' : 'request';
    return new AppError(
      'OLLAMA_CONNECTION_FAILED',
      `Could not complete the Ollama ${mode} to ${this.config.ollama.baseUrl} within ${this.config.ollama.requestTimeoutMs}ms.`,
      {
        baseUrl: this.config.ollama.baseUrl,
        model: this.config.ollama.model,
        timeoutMs: this.config.ollama.requestTimeoutMs,
        networkError: describeNetworkError(error),
      },
    );
  }

  private toOllamaMessage(message: ChatMessage): OllamaMessage {
    return {
      role: message.role,
      content: message.content,
    };
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
