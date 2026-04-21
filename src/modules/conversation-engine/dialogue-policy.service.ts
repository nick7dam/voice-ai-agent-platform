import { Injectable } from '@nestjs/common';
import {
  DialogueDecision,
  LiveIntentState,
  TranscriptFragment,
} from '../../common/types/conversation.types';
import { SessionState } from '../../common/types/session.types';
import { ConversationProfile } from './conversation-profile.registry';

@Injectable()
export class DialoguePolicyService {
  evaluateFragment(
    session: SessionState,
    profile: ConversationProfile,
    fragment: TranscriptFragment,
  ): DialogueDecision {
    const state = session.conversation?.liveIntent;
    if (!state || !fragment.normalizedText) {
      return {
        action: 'ignore',
        reason: 'empty_fragment',
      };
    }

    const lower = state.pendingThought.text.toLowerCase();
    if (/^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/.test(lower)) {
      return {
        action: 'ignore',
        reason: 'filler_only',
      };
    }

    const incompleteReason = state.pendingThought.incompleteReason;
    const delayMs = incompleteReason
      ? profile.incompleteHoldMs
      : profile.defaultHoldMs;

    return {
      action: 'wait',
      reason: incompleteReason ?? 'collect_more_context',
      delayMs,
    };
  }

  evaluateCommittedThought(
    session: SessionState,
    profile: ConversationProfile,
  ): DialogueDecision {
    const state = session.conversation?.liveIntent;
    const committedUserText = state?.pendingThought.text.replace(/\s+/g, ' ').trim();

    if (!state || !committedUserText) {
      return {
        action: 'ignore',
        reason: 'nothing_to_commit',
      };
    }

    if (/^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/.test(
      committedUserText.toLowerCase(),
    )) {
      return {
        action: 'ignore',
        reason: 'filler_only',
      };
    }

    if (profile.key === 'generic') {
      return {
        action: 'act',
        reason: 'general_assistant_turn_ready',
        committedUserText,
        shouldReason: true,
      };
    }

    const correctedSlot = this.findCorrectedSlot(state, profile);
    if (correctedSlot) {
      return {
        action: 'confirm',
        reason: 'slot_corrected',
        slotKey: correctedSlot.key,
        responseText: `Thanks. Just to confirm, the ${correctedSlot.label} is ${correctedSlot.value}.`,
        committedUserText,
        shouldReason: false,
      };
    }

    const nextMissingActionSlot = this.findNextMissingActionSlot(state, profile);
    if (nextMissingActionSlot) {
      return {
        action: 'ask',
        reason: 'missing_action_ready_slot',
        slotKey: nextMissingActionSlot.key,
        responseText: nextMissingActionSlot.askPrompt,
        committedUserText,
        shouldReason: false,
      };
    }

    if (this.hasActionReadyContext(state, profile)) {
      return {
        action: 'act',
        reason: 'minimum_booking_context_ready',
        committedUserText,
        shouldReason: true,
      };
    }

    const nextMissingRequired = this.findNextMissingRequiredSlot(state, profile);
    if (nextMissingRequired) {
      return {
        action: 'ask',
        reason: 'missing_required_slot',
        slotKey: nextMissingRequired.key,
        responseText: nextMissingRequired.askPrompt,
        committedUserText,
        shouldReason: false,
      };
    }

    return {
      action: 'act',
      reason: 'committed_turn_ready',
      committedUserText,
      shouldReason: true,
    };
  }

  private findCorrectedSlot(
    state: LiveIntentState,
    profile: ConversationProfile,
  ) {
    return profile.slotOrder
      .map((slotKey) => state.slots[slotKey])
      .find((slot) => slot?.status === 'corrected' && slot.value);
  }

  private findNextMissingRequiredSlot(
    state: LiveIntentState,
    profile: ConversationProfile,
  ) {
    return profile.slotOrder
      .map((slotKey) => profile.slotDefinitions[slotKey])
      .find((slot) => {
        if (!slot?.required) {
          return false;
        }

        const current = state.slots[slot.key];
        return !current?.value;
      });
  }

  private findNextMissingActionSlot(
    state: LiveIntentState,
    profile: ConversationProfile,
  ) {
    return profile.actionReadySlotKeys
      .map((slotKey) => profile.slotDefinitions[slotKey])
      .find((slot) => {
        if (!slot) {
          return false;
        }

        const current = state.slots[slot.key];
        return !current?.value;
      });
  }

  private hasActionReadyContext(
    state: LiveIntentState,
    profile: ConversationProfile,
  ): boolean {
    if (!profile.actionReadySlotKeys.length) {
      return false;
    }

    return profile.actionReadySlotKeys.every((slotKey) => {
      const slot = state.slots[slotKey];
      return Boolean(slot?.value);
    });
  }
}
