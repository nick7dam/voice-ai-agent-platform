import { Injectable, Logger } from '@nestjs/common';
import { ServerEvent } from '../../common/types/realtime-events';
import { elapsedMs, nowIso } from '../../common/utils/timing';
import { AppError, toErrorPayload } from '../../common/types/errors';
import { ReasoningService } from '../reasoning/reasoning.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { TaskConfig } from '../tasks/task-config.types';
import { PromptBuilderService } from './prompt-builder.service';

export type OrchestratorEmit = (event: ServerEvent) => void;

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly callEndMarker = '[[END_CALL]]';

  constructor(
    private readonly sessions: SessionsService,
    private readonly tasks: TaskRegistryService,
    private readonly prompts: PromptBuilderService,
    private readonly reasoning: ReasoningService,
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
        this.emitAssistantText(
          sessionId,
          turnId,
          "I didn't catch that. Please try again.",
          startedAt,
          emit,
        );
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

      this.sessions.appendHistory(sessionId, {
        role: 'user',
        text: trimmedTranscript,
        at: nowIso(),
      });

      this.logger.log(`reasoning.start session=${sessionId} turn=${turnId}`);

      let firstTokenEmitted = false;
      let speechCursor = 0;
      let speechTextChunkIndex = 0;
      let streamedText = '';

      const emitFirstToken = () => {
        if (firstTokenEmitted) {
          return;
        }

        firstTokenEmitted = true;
        emit({
          type: 'reasoning.first_token',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            latencyMs: elapsedMs(startedAt),
            source: 'stream',
          },
        });
      };

      const emitSpeechTextChunk = (text: string, final: boolean) => {
        const speech = this.sanitizeAssistantPlainText(text);
        if (!speech) {
          return;
        }

        emit({
          type: 'assistant.text.chunk',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            text: speech,
            index: speechTextChunkIndex,
            final,
          },
        });
        speechTextChunkIndex += 1;
      };

      const ensureTurnCurrent = () => {
        if (!this.isTurnCurrent(sessionId, turnId)) {
          throw new AppError(
            'TURN_INTERRUPTED',
            'Reasoning stopped because a newer turn interrupted this response.',
          );
        }
      };

      const result = await this.reasoning.stream(
        {
          messages,
          temperature: 0.15,
        },
        {
          onTextDelta: (delta) => {
            ensureTurnCurrent();
            streamedText += delta;
            if (delta.trim()) {
              emitFirstToken();
            }

            const chunks = this.extractSpeechChunks(
              streamedText,
              speechCursor,
              false,
            );

            for (const chunk of chunks) {
              speechCursor = chunk.endIndex;
              emitSpeechTextChunk(chunk.text, false);
            }
          },
        },
      );

      ensureTurnCurrent();

      const shouldEndCall =
        this.shouldEndCall(result.text) ||
        this.isCallEndingUserText(trimmedTranscript);
      const safeText = this.normalizeAssistantText(result.text, task);
      const finalSpeechChunks = this.extractSpeechChunks(
        safeText,
        speechCursor,
        true,
      );

      for (const chunk of finalSpeechChunks) {
        speechCursor = chunk.endIndex;
        emitSpeechTextChunk(chunk.text, true);
      }

      this.emitAssistantText(sessionId, turnId, safeText, startedAt, emit);
      this.sessions.appendHistory(sessionId, {
        role: 'assistant',
        text: safeText,
        at: nowIso(),
      });
      this.sessions.setState(sessionId, 'idle');

      if (shouldEndCall) {
        emit({
          type: 'session.end_requested',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            reason: 'assistant_completed_call',
          },
        });
      }

      this.logger.log(
        `reasoning.end session=${sessionId} turn=${turnId} latencyMs=${elapsedMs(startedAt)} providerLatencyMs=${result.latencyMs}`,
      );
    } catch (error) {
      const payload = toErrorPayload(error);

      if (
        payload.code === 'TURN_INTERRUPTED' ||
        !this.isTurnCurrent(sessionId, turnId)
      ) {
        this.logger.log(
          `reasoning.cancelled session=${sessionId} turn=${turnId} code=${payload.code}`,
        );
        return;
      }

      this.sessions.setState(sessionId, 'idle');
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

  private isTurnCurrent(sessionId: string, turnId: string): boolean {
    try {
      return this.sessions.isCurrentTurn(sessionId, turnId);
    } catch {
      return false;
    }
  }

  private emitAssistantText(
    sessionId: string,
    turnId: string,
    text: string,
    startedAt: bigint,
    emit: OrchestratorEmit,
  ): void {
    emit({
      type: 'assistant.response',
      sessionId,
      timestamp: nowIso(),
      payload: {
        turnId,
        text,
        latencyMs: elapsedMs(startedAt),
      },
    });
  }

  private normalizeAssistantText(text: string, task: TaskConfig): string {
    const fallback = 'Done.';
    const compact =
      this.sanitizeAssistantPlainText(
        (text || fallback).replaceAll(this.callEndMarker, ''),
      ) || fallback;
    return this.limitResponseForPhoneCall(
      compact,
      task.responsePolicy.maxResponseChars,
    );
  }

  private shouldEndCall(text: string): boolean {
    return text.includes(this.callEndMarker);
  }

  private isCallEndingUserText(text: string): boolean {
    return /\b(bye|goodbye|that'?s all|that is all|nothing else|no thanks|no thank you|all good|end the call|hang up)\b/i.test(
      text,
    );
  }

  private sanitizeAssistantPlainText(text: string): string {
    return text
      .replace(/\r/g, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(
        /\[(?:laugh|laughter|chuckle|cough|sigh|gasp|breath|sniff|clear throat|clears throat)\]/gi,
        ' ',
    )
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private limitResponseForPhoneCall(text: string, maxChars: number): string {
    const clipped = text.slice(0, maxChars).trim();
    const sentences = clipped.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clipped];

    if (sentences.length <= 2) {
      return clipped;
    }

    const questionIndex = sentences.findIndex(
      (sentence, index) => index < 3 && sentence.includes('?'),
    );
    const keepCount =
      questionIndex >= 0 ? questionIndex + 1 : clipped.length <= 260 ? 3 : 2;
    return sentences.slice(0, keepCount).join(' ').replace(/\s+/g, ' ').trim();
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
    const minSentenceChars = 36;
    const preferredChars = 95;
    const maxChars = 145;
    const minSoftBoundaryChars = 45;

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

      if (softBoundary >= minSoftBoundaryChars) {
        return softBoundary + 1;
      }

      const lastSpace = text.lastIndexOf(' ', maxChars);
      if (lastSpace >= minSoftBoundaryChars) {
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
}
