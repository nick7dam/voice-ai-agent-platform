import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  TranscriptFragment,
  SessionConversationState,
} from '../../common/types/conversation.types';
import { SessionState } from '../../common/types/session.types';
import { nowIso } from '../../common/utils/timing';

@Injectable()
export class TranscriptLayerService {
  recordFragment(
    session: SessionState,
    text: string,
  ): TranscriptFragment {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const fragment: TranscriptFragment = {
      id: randomUUID(),
      sessionId: session.id,
      text,
      normalizedText,
      receivedAt: nowIso(),
      confidence: null,
      isInterrupting: Boolean(session.activeTurnId),
      source: 'stt',
    };

    const conversation = this.ensureConversation(session);
    conversation.transcriptFragments.push(fragment);
    conversation.transcriptFragments = conversation.transcriptFragments.slice(-40);
    return fragment;
  }

  private ensureConversation(session: SessionState): SessionConversationState {
    if (!session.conversation) {
      throw new Error(
        'Conversation state must be initialized before recording transcript fragments.',
      );
    }

    return session.conversation;
  }
}
