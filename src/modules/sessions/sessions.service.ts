import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import {
  ConversationTurn,
  InterruptedAssistantTurn,
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
      recentAssistantResponses: [],
      createdAt: now,
      updatedAt: now,
      currentState: 'idle',
      turnSequence: 0,
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

  beginTextTurn(sessionId: string): string {
    const session = this.get(sessionId);

    if (session.activeTurnId && session.currentState === 'reasoning') {
      this.markTurnInterrupted(session, 'superseded_by_new_turn');
    }

    session.turnSequence += 1;
    session.activeTurnId = `turn-${session.turnSequence}`;
    session.currentState = 'reasoning';
    session.updatedAt = nowIso();

    return session.activeTurnId;
  }

  interrupt(sessionId: string, reason?: string): void {
    const session = this.get(sessionId);

    this.markTurnInterrupted(session, reason);
    session.currentState = 'idle';
    session.updatedAt = nowIso();
  }

  setState(sessionId: string, state: SessionState['currentState']): void {
    const session = this.get(sessionId);
    session.currentState = state;
    session.updatedAt = nowIso();
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

  isCurrentTurn(sessionId: string, turnId: string): boolean {
    const session = this.get(sessionId);
    return (
      session.activeTurnId === turnId &&
      !session.interruptedTurnIds.includes(turnId)
    );
  }

  noteAssistantText(
    sessionId: string,
    turnId: string,
    text: string,
    finalized: boolean,
  ): void {
    const session = this.get(sessionId);
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!turnId || !normalized) {
      return;
    }

    const now = nowIso();
    const draft = session.assistantDraftTurn;

    if (!draft || draft.turnId !== turnId) {
      session.assistantDraftTurn = {
        turnId,
        text: normalized,
        finalized,
        updatedAt: now,
      };
      session.updatedAt = now;
      return;
    }

    session.assistantDraftTurn = {
      ...draft,
      text: finalized
        ? normalized
        : this.mergeAssistantDraftText(draft.text, normalized),
      finalized: draft.finalized || finalized,
      updatedAt: now,
    };
    session.updatedAt = now;
  }

  clearInterruptedAssistantTurn(sessionId: string): void {
    const session = this.get(sessionId);
    if (!session.interruptedAssistantTurn) {
      return;
    }

    delete session.interruptedAssistantTurn;
    session.updatedAt = nowIso();
  }

  private markTurnInterrupted(session: SessionState, reason?: string): void {
    const turnId = session.activeTurnId;
    if (!turnId) {
      return;
    }

    if (!session.interruptedTurnIds.includes(turnId)) {
      session.interruptedTurnIds.push(turnId);
    }

    const interruptedAssistantTurn = this.buildInterruptedAssistantTurn(
      session,
      turnId,
      reason,
    );
    if (interruptedAssistantTurn) {
      session.interruptedAssistantTurn = interruptedAssistantTurn;
    }
  }

  private buildInterruptedAssistantTurn(
    session: SessionState,
    turnId: string,
    reason?: string,
  ): InterruptedAssistantTurn | undefined {
    const draft =
      session.assistantDraftTurn?.turnId === turnId
        ? session.assistantDraftTurn
        : undefined;
    const historyMatch = [...session.history]
      .reverse()
      .find((turn) => turn.role === 'assistant' && turn.turnId === turnId);
    const text =
      draft?.text ?? historyMatch?.text.replace(/\s+/g, ' ').trim() ?? '';

    if (!text) {
      return undefined;
    }

    return {
      turnId,
      text,
      reason,
      at: nowIso(),
      finalized: draft?.finalized ?? Boolean(historyMatch),
    };
  }

  private mergeAssistantDraftText(current: string, next: string): string {
    if (!current) {
      return next;
    }

    if (next === current || current.endsWith(next)) {
      return current;
    }

    if (next.startsWith(current)) {
      return next;
    }

    return `${current} ${next}`.replace(/\s+/g, ' ').trim();
  }
}
