import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  ConsumedAudioTurn,
  ConversationTurn,
  MemoryFact,
  SessionState,
} from '../../common/types/session.types';
import { nowIso } from '../../common/utils/timing';
import type { AppConfig } from '../../config/app.config';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly sessions = new Map<string, SessionState>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  create(
    taskKey = this.config.defaultTaskKey,
    metadata?: Record<string, unknown>,
  ): SessionState {
    const now = nowIso();
    const session: SessionState = {
      id: randomUUID(),
      taskKey,
      history: [],
      memory: [],
      recentAssistantResponses: [],
      audio: {
        chunks: [],
        mimeType: 'audio/webm',
      },
      createdAt: now,
      updatedAt: now,
      currentState: 'idle',
      turnSequence: 0,
      audioOutputEnabled: true,
      interruptedTurnIds: [],
      metadata,
    };

    this.sessions.set(session.id, session);
    this.logger.log(`session.start ${session.id} task=${taskKey}`);
    return session;
  }

  get(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AppError(
        'SESSION_NOT_FOUND',
        `Session ${sessionId} was not found.`,
      );
    }
    return session;
  }

  end(sessionId: string): SessionState {
    const session = this.get(sessionId);
    session.currentState = 'ended';
    session.updatedAt = nowIso();
    this.sessions.delete(sessionId);
    this.logger.log(`session.end ${sessionId}`);
    return session;
  }

  beginTurn(sessionId: string): string {
    const session = this.get(sessionId);
    const now = nowIso();

    if (session.activeTurnId && session.currentState === 'reasoning') {
      session.interruptedTurnIds.push(session.activeTurnId);
    }

    session.turnSequence += 1;
    session.activeTurnId = `turn-${session.turnSequence}`;
    session.audio = {
      turnId: session.activeTurnId,
      chunks: [],
      mimeType: 'audio/webm',
      startedAt: now,
    };
    session.currentState = 'listening';
    session.updatedAt = now;

    return session.activeTurnId;
  }

  ensureAudioTurn(
    sessionId: string,
    mimeType?: string,
    sampleRate?: number,
  ): string {
    const session = this.get(sessionId);

    if (!session.audio.turnId || session.audio.chunks.length === 0) {
      this.beginTurn(sessionId);
    }

    if (mimeType) {
      session.audio.mimeType = mimeType;
    }

    if (sampleRate) {
      session.audio.sampleRate = sampleRate;
    }

    return session.audio.turnId ?? this.beginTurn(sessionId);
  }

  appendAudioChunk(
    sessionId: string,
    chunk: Buffer,
    options?: { mimeType?: string; sampleRate?: number },
  ): { turnId: string; bufferedBytes: number } {
    const session = this.get(sessionId);
    const turnId = this.ensureAudioTurn(
      sessionId,
      options?.mimeType,
      options?.sampleRate,
    );

    const bufferedBytes =
      session.audio.chunks.reduce((total, item) => total + item.byteLength, 0) +
      chunk.byteLength;

    if (bufferedBytes > this.config.maxAudioBufferBytes) {
      throw new AppError(
        'AUDIO_BUFFER_TOO_LARGE',
        `Audio buffer exceeded ${this.config.maxAudioBufferBytes} bytes.`,
      );
    }

    session.audio.chunks.push(chunk);
    session.currentState = 'listening';
    session.updatedAt = nowIso();

    return { turnId, bufferedBytes };
  }

  consumeAudioTurn(sessionId: string): ConsumedAudioTurn {
    const session = this.get(sessionId);

    if (!session.audio.turnId || session.audio.chunks.length === 0) {
      throw new AppError(
        'EMPTY_AUDIO_TURN',
        'No audio has been buffered for this turn.',
      );
    }

    const turn: ConsumedAudioTurn = {
      turnId: session.audio.turnId,
      audio: Buffer.concat(session.audio.chunks),
      mimeType: session.audio.mimeType,
      sampleRate: session.audio.sampleRate,
    };

    session.audio = {
      chunks: [],
      mimeType: 'audio/webm',
    };
    session.currentState = 'transcribing';
    session.updatedAt = nowIso();

    return turn;
  }

  beginTextTurn(sessionId: string): string {
    const session = this.get(sessionId);

    if (session.activeTurnId && session.currentState === 'reasoning') {
      session.interruptedTurnIds.push(session.activeTurnId);
    }

    session.turnSequence += 1;
    session.activeTurnId = `turn-${session.turnSequence}`;
    session.currentState = 'reasoning';
    session.updatedAt = nowIso();

    return session.activeTurnId;
  }

  interrupt(sessionId: string): void {
    const session = this.get(sessionId);

    if (session.activeTurnId) {
      session.interruptedTurnIds.push(session.activeTurnId);
    }

    session.currentState = 'idle';
    session.updatedAt = nowIso();
  }

  setState(sessionId: string, state: SessionState['currentState']): void {
    const session = this.get(sessionId);
    session.currentState = state;
    session.updatedAt = nowIso();
  }

  setAudioOutputEnabled(sessionId: string, enabled: boolean): void {
    const session = this.get(sessionId);
    session.audioOutputEnabled = enabled;
    session.updatedAt = nowIso();
  }

  isAudioOutputEnabled(sessionId: string): boolean {
    return this.get(sessionId).audioOutputEnabled;
  }

  appendHistory(sessionId: string, turn: ConversationTurn): void {
    const session = this.get(sessionId);
    session.history.push(turn);
    session.history = session.history.slice(-20);

    if (turn.role === 'assistant') {
      session.recentAssistantResponses.push(turn.text);
      session.recentAssistantResponses =
        session.recentAssistantResponses.slice(-5);
    }

    session.updatedAt = nowIso();
  }

  addMemoryFact(
    sessionId: string,
    fact: string,
    category?: string,
  ): MemoryFact {
    const session = this.get(sessionId);
    const memoryFact: MemoryFact = {
      id: randomUUID(),
      fact,
      category,
      createdAt: nowIso(),
    };

    session.memory.push(memoryFact);
    session.memory = session.memory.slice(-50);
    session.updatedAt = nowIso();

    return memoryFact;
  }

  listMemory(sessionId: string, limit = 20): MemoryFact[] {
    const session = this.get(sessionId);
    return session.memory.slice(-limit);
  }

  isCurrentTurn(sessionId: string, turnId: string): boolean {
    const session = this.get(sessionId);
    return (
      session.activeTurnId === turnId &&
      !session.interruptedTurnIds.includes(turnId)
    );
  }
}
