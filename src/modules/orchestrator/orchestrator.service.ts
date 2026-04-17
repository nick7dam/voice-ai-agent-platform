import { Injectable, Logger } from '@nestjs/common';
import { ServerEvent } from '../../common/types/realtime-events';
import { ChatMessage } from '../../common/types/reasoning.types';
import { NormalizedToolResult } from '../../common/types/tool.types';
import { elapsedMs, nowIso } from '../../common/utils/timing';
import { ReasoningService } from '../reasoning/reasoning.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { TaskConfig } from '../tasks/task-config.types';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ToolRuntimeService } from '../tools/tool-runtime.service';
import { TtsService } from '../tts/tts.service';
import { PromptBuilderService } from './prompt-builder.service';
import { AppError, toErrorPayload } from '../../common/types/errors';

export type OrchestratorEmit = (event: ServerEvent) => void;

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly tasks: TaskRegistryService,
    private readonly prompts: PromptBuilderService,
    private readonly reasoning: ReasoningService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly toolRuntime: ToolRuntimeService,
    private readonly tts: TtsService,
  ) {}

  async handleTranscript(
    sessionId: string,
    turnId: string,
    transcript: string,
    emit: OrchestratorEmit,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();

    try {
      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        this.logger.log(
          `reasoning.skip_stale session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      const trimmedTranscript = transcript.trim();
      if (!trimmedTranscript) {
        this.sessions.appendHistory(sessionId, {
          role: 'assistant',
          text: "I didn't catch that. Please try again.",
          at: nowIso(),
        });
        emit({
          type: 'assistant.response',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            text: "I didn't catch that. Please try again.",
            latencyMs: elapsedMs(startedAt),
          },
        });
        this.sessions.setState(sessionId, 'idle');
        return;
      }

      this.sessions.setState(sessionId, 'reasoning');
      emit({
        type: 'reasoning.started',
        sessionId,
        timestamp: nowIso(),
        payload: { turnId },
      });

      const session = this.sessions.get(sessionId);
      const task = this.tasks.get(session.taskKey, true);
      const messages = this.prompts.build(session, task, trimmedTranscript);
      const tools = this.toolRegistry.toLlmTools(task.allowedTools);

      this.sessions.appendHistory(sessionId, {
        role: 'user',
        text: trimmedTranscript,
        at: nowIso(),
      });

      this.logger.log(`reasoning.start session=${sessionId} turn=${turnId}`);
      let earlyAudioStarted = false;
      let speechCursor = 0;
      let queuedSpeech = Promise.resolve();
      let streamedText = '';
      const queueEarlySpeech = (text: string) => {
        const speech = text.replace(/\s+/g, ' ').trim();

        if (!speech) {
          return;
        }

        earlyAudioStarted = true;
        this.logger.log(
          `tts.early.start session=${sessionId} turn=${turnId} chars=${speech.length}`,
        );
        queuedSpeech = queuedSpeech
          .then(() => this.emitAssistantAudio(sessionId, turnId, speech, emit))
          .catch((error: unknown) => {
            const payload = toErrorPayload(error);
            this.logger.warn(
              `tts.early.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message}`,
            );
          });
      };
      const shouldUseTools = this.shouldUseTools(trimmedTranscript);
      const initial = shouldUseTools
        ? await this.reasoning.generate({
            messages,
            tools,
            temperature: 0.2,
          })
        : await this.reasoning.stream(
            {
              messages,
              temperature: 0.15,
            },
            {
              onTextDelta: (delta) => {
                streamedText += delta;

                if (
                  !this.tts.isEnabled() ||
                  !this.tts.shouldEmitEarlyAudio() ||
                  !this.sessions.isAudioOutputEnabled(sessionId)
                ) {
                  return;
                }

                if (this.tts.shouldStreamPhrases()) {
                  const chunks = this.extractSpeechChunks(
                    streamedText,
                    speechCursor,
                    false,
                  );

                  for (const chunk of chunks) {
                    speechCursor = chunk.endIndex;
                    queueEarlySpeech(chunk.text);
                  }

                  return;
                }

                if (earlyAudioStarted) {
                  return;
                }

                const [earlyChunk] = this.extractSpeechChunks(
                  streamedText,
                  speechCursor,
                  false,
                );
                if (earlyChunk) {
                  speechCursor = earlyChunk.endIndex;
                  queueEarlySpeech(earlyChunk.text);
                }
              },
            },
          );

      let finalText = initial.text;
      let providerLatencyMs = initial.latencyMs;

      if (initial.toolCalls.length > 0) {
        const toolResults = await this.executeTools(
          sessionId,
          turnId,
          task,
          initial.toolCalls,
          emit,
        );

        const followupMessages = this.buildToolFollowupMessages(
          messages,
          initial.text,
          initial.toolCalls,
          toolResults,
        );

        const final = await this.reasoning.generate({
          messages: followupMessages,
          temperature: 0.2,
        });

        finalText = final.text;
        providerLatencyMs +=
          final.latencyMs +
          toolResults.reduce((sum, item) => sum + item.latencyMs, 0);
      }

      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        this.logger.log(
          `assistant.response.skip_stale session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      const safeText = this.normalizeAssistantText(finalText, task);
      const totalLatencyMs = elapsedMs(startedAt);
      this.sessions.appendHistory(sessionId, {
        role: 'assistant',
        text: safeText,
        at: nowIso(),
      });
      this.sessions.setState(sessionId, 'idle');

      emit({
        type: 'assistant.response',
        sessionId,
        timestamp: nowIso(),
        payload: {
          turnId,
          text: safeText,
          latencyMs: totalLatencyMs,
        },
      });

      if (earlyAudioStarted && this.tts.shouldStreamPhrases()) {
        const chunks = this.extractSpeechChunks(safeText, speechCursor, true);
        for (const chunk of chunks) {
          speechCursor = chunk.endIndex;
          queueEarlySpeech(chunk.text);
        }
      } else if (!earlyAudioStarted) {
        void this.emitAssistantAudio(sessionId, turnId, safeText, emit);
      }

      this.logger.log(
        `reasoning.end session=${sessionId} turn=${turnId} latencyMs=${totalLatencyMs} providerLatencyMs=${providerLatencyMs} toolsEnabled=${shouldUseTools} earlyAudio=${earlyAudioStarted}`,
      );
    } catch (error) {
      this.sessions.setState(sessionId, 'idle');
      const payload = toErrorPayload(error);
      emit({
        type: 'error',
        sessionId,
        timestamp: nowIso(),
        payload,
      });
      this.logger.error(
        `reasoning.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message}`,
      );
    }
  }

  private async executeTools(
    sessionId: string,
    turnId: string,
    task: TaskConfig,
    toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
    emit: OrchestratorEmit,
  ): Promise<NormalizedToolResult[]> {
    const results: NormalizedToolResult[] = [];

    for (const toolCall of toolCalls) {
      emit({
        type: 'tool.called',
        sessionId,
        timestamp: nowIso(),
        payload: { turnId, toolCall },
      });

      const result = await this.toolRuntime.execute(
        toolCall,
        { sessionId, turnId },
        task.allowedTools,
      );

      emit({
        type: 'tool.result',
        sessionId,
        timestamp: nowIso(),
        payload: { turnId, result },
      });
      results.push(result);
    }

    return results;
  }

  private buildToolFollowupMessages(
    originalMessages: ChatMessage[],
    assistantText: string,
    toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
    results: NormalizedToolResult[],
  ): ChatMessage[] {
    return [
      ...originalMessages,
      {
        role: 'assistant',
        content: assistantText,
        toolCalls,
      },
      ...results.map<ChatMessage>((result) => ({
        role: 'tool',
        name: result.name,
        toolCallId: result.toolCallId,
        content: JSON.stringify(
          result.ok ? result.output : { error: result.error },
        ),
      })),
      {
        role: 'user',
        content:
          'Use the tool results above to answer the user. Return only the final user-facing plain text response.',
      },
    ];
  }

  private normalizeAssistantText(text: string, task: TaskConfig): string {
    const fallback = 'Done.';
    const compact = (text || fallback).replace(/\r/g, '').trim() || fallback;
    return compact.slice(0, task.responsePolicy.maxResponseChars);
  }

  private shouldUseTools(transcript: string): boolean {
    const lower = transcript.toLowerCase();

    return (
      /\b(remember|memory|memor(y|ies)|recall|store this|save this)\b/.test(
        lower,
      ) ||
      /\b(time|date|today|timezone)\b/.test(lower) ||
      /\b(calculate|math|plus|minus|times|divided by)\b/.test(lower) ||
      /\d\s*[-+*/^]\s*\d/.test(lower)
    );
  }

  private extractSpeechChunks(
    text: string,
    cursor: number,
    force: boolean,
  ): Array<{ text: string; endIndex: number }> {
    const chunks: Array<{ text: string; endIndex: number }> = [];
    const flushRemainder = force;
    let offset = cursor;

    while (offset < text.length) {
      const remaining = text.slice(offset);
      const boundary = this.findSpeechBoundary(remaining, force);

      if (!boundary) {
        break;
      }

      const chunk = remaining.slice(0, boundary).replace(/\s+/g, ' ').trim();
      offset += boundary;

      if (chunk.length >= 2) {
        chunks.push({ text: chunk, endIndex: offset });
      }

      force = flushRemainder;
    }

    return chunks;
  }

  private findSpeechBoundary(text: string, force: boolean): number | undefined {
    const minSentenceChars = 24;
    const preferredChars = 90;
    const maxChars = 140;

    for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
      const end = (match.index ?? 0) + 1;
      if (end >= minSentenceChars) {
        return end;
      }
    }

    if (text.length >= preferredChars) {
      const softBoundary = Math.max(
        text.lastIndexOf(',', maxChars),
        text.lastIndexOf(';', maxChars),
        text.lastIndexOf(':', maxChars),
      );

      if (softBoundary >= 50) {
        return softBoundary + 1;
      }

      const lastSpace = text.lastIndexOf(' ', maxChars);
      if (lastSpace >= 50) {
        return lastSpace;
      }

      return Math.min(text.length, maxChars);
    }

    if (!force) {
      return undefined;
    }

    const trimmed = text.trimEnd();
    return trimmed.length > 0 ? trimmed.length : undefined;
  }

  private async emitAssistantAudio(
    sessionId: string,
    turnId: string,
    text: string,
    emit: OrchestratorEmit,
  ): Promise<void> {
    if (!this.tts.isEnabled()) {
      return;
    }

    if (!this.sessions.isAudioOutputEnabled(sessionId)) {
      this.logger.log(`tts.skip_disabled session=${sessionId} turn=${turnId}`);
      return;
    }

    const segments = this.tts.splitText(text);

    if (segments.length === 0) {
      return;
    }

    const metadata = this.tts.getMetadata();

    emit({
      type: 'assistant.audio.started',
      sessionId,
      timestamp: nowIso(),
      payload: {
        turnId,
        model: metadata.model,
        voice: metadata.voice,
        format: this.tts.canStreamAudio() ? 'pcm_s16le' : metadata.format,
        segmentCount: segments.length,
        streaming: this.tts.canStreamAudio(),
      },
    });

    try {
      if (this.tts.canStreamAudio()) {
        await this.emitAssistantAudioStream(sessionId, turnId, segments, emit);
      } else {
        await this.emitAssistantAudioBuffers(sessionId, turnId, segments, emit);
      }

      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        return;
      }

      emit({
        type: 'assistant.audio.ended',
        sessionId,
        timestamp: nowIso(),
        payload: {
          turnId,
          segmentCount: segments.length,
        },
      });
    } catch (error) {
      const payload = toErrorPayload(error);
      if (payload.code === 'TTS_STREAM_CANCELLED') {
        this.logger.log(
          `tts.stream.cancelled session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      emit({
        type: 'error',
        sessionId,
        timestamp: nowIso(),
        payload,
      });
      this.logger.warn(
        `tts.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message} details=${JSON.stringify(payload.details ?? {})}`,
      );
    }
  }

  private async emitAssistantAudioStream(
    sessionId: string,
    turnId: string,
    segments: ReturnType<TtsService['splitText']>,
    emit: OrchestratorEmit,
  ): Promise<void> {
    for (const segment of segments) {
      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        this.logger.log(
          `tts.stream.skip_stale session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      await this.tts.streamSegment(segment, {
        onChunk: (chunk) => {
          if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
            this.logger.log(
              `tts.stream.chunk.skip_stale session=${sessionId} turn=${turnId}`,
            );
            throw new AppError(
              'TTS_STREAM_CANCELLED',
              'TTS stream cancelled because the turn is stale.',
            );
          }

          emit({
            type: 'assistant.audio.chunk',
            sessionId,
            timestamp: nowIso(),
            payload: {
              turnId,
              index: chunk.segmentIndex,
              total: chunk.segmentTotal,
              audioBase64: chunk.audio.toString('base64'),
              mimeType: chunk.mimeType,
              latencyMs: chunk.latencyMs,
              streaming: true,
              sampleRate: chunk.sampleRate,
              encoding: chunk.encoding,
              chunkIndex: chunk.chunkIndex,
            },
          });
        },
      });
    }
  }

  private async emitAssistantAudioBuffers(
    sessionId: string,
    turnId: string,
    segments: ReturnType<TtsService['splitText']>,
    emit: OrchestratorEmit,
  ): Promise<void> {
    for (const batch of this.batchSegments(segments)) {
      const pendingAudio = batch.map((segment) =>
        this.tts.synthesizeSegment(segment),
      );

      for (const promise of pendingAudio) {
        if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
          this.logger.log(`tts.skip_stale session=${sessionId} turn=${turnId}`);
          return;
        }

        const audio = await promise;

        if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
          this.logger.log(
            `tts.chunk.skip_stale session=${sessionId} turn=${turnId}`,
          );
          return;
        }

        emit({
          type: 'assistant.audio.chunk',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            index: audio.segmentIndex,
            total: audio.segmentTotal,
            audioBase64: audio.audio.toString('base64'),
            mimeType: audio.mimeType,
            latencyMs: audio.latencyMs,
          },
        });
      }
    }
  }

  private batchSegments(
    segments: ReturnType<TtsService['splitText']>,
  ): Array<ReturnType<TtsService['splitText']>> {
    const concurrency = Math.min(this.tts.getConcurrency(), segments.length);
    const batches: Array<ReturnType<TtsService['splitText']>> = [];

    for (let index = 0; index < segments.length; index += concurrency) {
      batches.push(segments.slice(index, index + concurrency));
    }

    return batches;
  }
}
