import { Injectable } from '@nestjs/common';
import {
  DialogueDecision,
  LiveIntentState,
  TranscriptFragment,
} from '../../common/types/conversation.types';
import { SessionState } from '../../common/types/session.types';
import { nowIso } from '../../common/utils/timing';
import { SessionsService } from '../sessions/sessions.service';
import { DialoguePolicyService } from './dialogue-policy.service';
import { LiveIntentStateService } from './live-intent-state.service';
import {
  ConversationProfile,
  ConversationProfileRegistryService,
} from './conversation-profile.registry';
import { SemanticPatchService } from './semantic-patch.service';
import { TranscriptLayerService } from './transcript-layer.service';

export interface FragmentIngestResult {
  fragment: TranscriptFragment;
  profile: ConversationProfile;
  liveIntent: LiveIntentState;
  decision: DialogueDecision;
}

export interface PendingThoughtCommitResult {
  profile: ConversationProfile;
  liveIntent: LiveIntentState;
  decision: DialogueDecision;
  committedUserText: string | null;
}

@Injectable()
export class ConversationEngineService {
  constructor(
    private readonly sessions: SessionsService,
    private readonly profiles: ConversationProfileRegistryService,
    private readonly transcriptLayer: TranscriptLayerService,
    private readonly semanticPatches: SemanticPatchService,
    private readonly liveIntent: LiveIntentStateService,
    private readonly policy: DialoguePolicyService,
  ) {}

  ingestFragment(sessionId: string, text: string): FragmentIngestResult {
    const session = this.sessions.get(sessionId);
    const conversation = this.liveIntent.ensureConversationState(session);
    const profile = this.profiles.getProfileForTask(session.taskKey);
    const fragment = this.transcriptLayer.recordFragment(session, text);
    const patches = this.semanticPatches.buildPatches(session, profile, fragment);
    const liveIntent = this.liveIntent.applyPatches(session, patches);
    const decision = this.policy.evaluateFragment(session, profile, fragment);

    conversation.lastDecision = {
      ...decision,
      at: nowIso(),
      consumed: false,
    };

    return {
      fragment,
      profile,
      liveIntent,
      decision,
    };
  }

  commitPendingThought(
    sessionId: string,
    _reason: string,
  ): PendingThoughtCommitResult | null {
    const session = this.sessions.get(sessionId);
    const conversation = this.liveIntent.ensureConversationState(session);
    const profile = this.profiles.getProfileForTask(session.taskKey);
    const pendingThought = conversation.liveIntent.pendingThought.text
      .replace(/\s+/g, ' ')
      .trim();

    if (!pendingThought) {
      return null;
    }

    this.liveIntent.promotePendingThoughtSlots(session, profile);
    const decision = this.policy.evaluateCommittedThought(session, profile);
    const liveIntent = this.liveIntent.applyPatches(session, [
      {
        type: 'set_floor',
        state: 'assistant_waiting',
        stability: 1,
        at: nowIso(),
      },
      {
        type: 'set_prompt',
        slotKey:
          decision.slotKey && (decision.action === 'ask' || decision.action === 'confirm')
            ? decision.slotKey
            : null,
        action:
          decision.slotKey && (decision.action === 'ask' || decision.action === 'confirm')
            ? decision.action
            : null,
        at: nowIso(),
      },
      {
        type: 'clear_pending_thought',
      },
    ]);

    conversation.lastDecision = {
      ...decision,
      at: nowIso(),
      consumed: false,
    };

    if (decision.action === 'ignore') {
      return {
        profile,
        liveIntent,
        decision,
        committedUserText: null,
      };
    }

    return {
      profile,
      liveIntent,
      decision,
      committedUserText: pendingThought,
    };
  }

  consumeLastDecision(
    session: SessionState,
    committedUserText: string,
  ): DialogueDecision | null {
    const conversation = session.conversation;
    const lastDecision = conversation?.lastDecision;

    if (
      !lastDecision ||
      lastDecision.consumed ||
      lastDecision.committedUserText !== committedUserText
    ) {
      return null;
    }

    lastDecision.consumed = true;
    const { at: _at, consumed: _consumed, ...decision } = lastDecision;
    return decision;
  }
}
