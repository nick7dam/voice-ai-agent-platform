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
import { toErrorPayload } from '../../common/types/errors';

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
      let streamedText = '';
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
                  earlyAudioStarted ||
                  !this.tts.isEnabled() ||
                  !this.sessions.isAudioOutputEnabled(sessionId)
                ) {
                  return;
                }

                const earlyText = this.extractEarlySpeech(streamedText);
                if (!earlyText) {
                  return;
                }

                earlyAudioStarted = true;
                this.logger.log(
                  `tts.early.start session=${sessionId} turn=${turnId} chars=${earlyText.length}`,
                );
                void this.emitAssistantAudio(
                  sessionId,
                  turnId,
                  earlyText,
                  emit,
                );
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

      if (!earlyAudioStarted) {
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

  private extractEarlySpeech(text: string): string | undefined {
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized.length < 24) {
      return undefined;
    }

    const firstSentence = normalized.match(/^.{24,}?[.!?](?=\s|$)/)?.[0];
    if (firstSentence) {
      return firstSentence.slice(0, 200);
    }

    if (normalized.length < 100) {
      return undefined;
    }

    const fallback = normalized.slice(0, 100);
    const lastSpace = fallback.lastIndexOf(' ');
    return `${fallback.slice(0, lastSpace > 50 ? lastSpace : 100).trim()}.`;
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
        format: metadata.format,
        segmentCount: segments.length,
      },
    });

    try {
      for (const batch of this.batchSegments(segments)) {
        const pendingAudio = batch.map((segment) =>
          this.tts.synthesizeSegment(segment),
        );

        for (const promise of pendingAudio) {
          if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
            this.logger.log(
              `tts.skip_stale session=${sessionId} turn=${turnId}`,
            );
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
