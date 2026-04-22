import { Injectable } from '@nestjs/common';
import {
  DialogueDecision,
  IntentSlotState,
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

    if (
      /^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/i.test(
        state.pendingThought.text.trim(),
      )
    ) {
      return {
        action: 'ignore',
        reason: 'filler_only',
      };
    }

    return {
      action: 'wait',
      reason: 'collect_more_context',
      delayMs: profile.defaultHoldMs,
    };
  }

  evaluateCommittedThought(
    session: SessionState,
    profile: ConversationProfile,
  ): DialogueDecision {
    const state = session.conversation?.liveIntent;
    const committedUserText = state?.pendingThought.text
      .replace(/\s+/g, ' ')
      .trim();

    if (!state || !committedUserText) {
      return {
        action: 'ignore',
        reason: 'nothing_to_commit',
      };
    }

    if (
      /^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/i.test(
        committedUserText,
      )
    ) {
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

    const explicitConfirmationSlot = this.findExplicitConfirmationSlot(
      committedUserText,
      state,
      profile,
    );
    if (explicitConfirmationSlot) {
      return this.buildConfirmationDecision(
        explicitConfirmationSlot,
        committedUserText,
        true,
      );
    }

    const promptedSlot = this.findPromptedSlot(state, profile);
    if (promptedSlot && !promptedSlot.slot.value) {
      return {
        action: 'ask',
        reason: 'prompted_slot_still_missing',
        slotKey: promptedSlot.definition.key,
        responseText: promptedSlot.definition.askPrompt,
        committedUserText,
        shouldReason: true,
      };
    }

    const slotNeedingConfirmation =
      promptedSlot &&
        promptedSlot.slot.value &&
        !this.isSlotActionReady(promptedSlot.slot)
        ? promptedSlot
        : this.findNextSlotNeedingConfirmation(state, profile);
    if (slotNeedingConfirmation) {
      return this.buildConfirmationDecision(
        slotNeedingConfirmation,
        committedUserText,
        false,
      );
    }

    const nextMissingActionSlot = this.findNextMissingActionSlot(
      state,
      profile,
    );
    if (nextMissingActionSlot) {
      return {
        action: 'ask',
        reason: 'missing_action_ready_slot',
        slotKey: nextMissingActionSlot.key,
        responseText: nextMissingActionSlot.askPrompt,
        committedUserText,
        shouldReason: true,
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

    const nextMissingRequired = this.findNextMissingRequiredSlot(
      state,
      profile,
    );
    if (nextMissingRequired) {
      return {
        action: 'ask',
        reason: 'missing_required_slot',
        slotKey: nextMissingRequired.key,
        responseText: nextMissingRequired.askPrompt,
        committedUserText,
        shouldReason: true,
      };
    }

    return {
      action: 'act',
      reason: 'committed_turn_ready',
      committedUserText,
      shouldReason: true,
    };
  }

  private findExplicitConfirmationSlot(
    committedUserText: string,
    state: LiveIntentState,
    profile: ConversationProfile,
  ) {
    const lower = committedUserText.toLowerCase();
    const requestPattern =
      /\b(confirm|check|repeat|read back|readback|say back)\b/;
    const requestedSlotKey = profile.slotOrder.find((slotKey) => {
      switch (slotKey) {
        case 'vehicleRegistration':
          return (
            requestPattern.test(lower) &&
            /\b(rego|registration|plate|regal)\b/.test(lower)
          );
        case 'phoneNumber':
          return (
            requestPattern.test(lower) &&
            /\b(phone|mobile|number)\b/.test(lower)
          );
        case 'customerEmail':
          return requestPattern.test(lower) && /\b(email|e-mail)\b/.test(lower);
        case 'customerName':
          return requestPattern.test(lower) && /\b(name)\b/.test(lower);
        default:
          return false;
      }
    });

    if (!requestedSlotKey) {
      return null;
    }

    const slot = state.slots[requestedSlotKey];
    const definition = profile.slotDefinitions[requestedSlotKey];
    if (!slot?.value || !definition) {
      return null;
    }

    return { definition, slot };
  }

  private findPromptedSlot(
    state: LiveIntentState,
    profile: ConversationProfile,
  ) {
    const slotKey = state.prompt.slotKey;
    if (!slotKey) {
      return null;
    }

    const definition = profile.slotDefinitions[slotKey];
    const slot = state.slots[slotKey];
    if (!definition || !slot) {
      return null;
    }

    return { definition, slot };
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
      return this.isSlotActionReady(slot);
    });
  }

  private findNextSlotNeedingConfirmation(
    state: LiveIntentState,
    profile: ConversationProfile,
  ) {
    return profile.actionReadySlotKeys
      .map((slotKey) => ({
        definition: profile.slotDefinitions[slotKey],
        slot: state.slots[slotKey],
      }))
      .find(({ definition, slot }) => {
        if (!definition || !slot?.value) {
          return false;
        }

        return !this.isSlotActionReady(slot);
      });
  }

  private buildConfirmationDecision(
    target: {
      definition: ConversationProfile['slotDefinitions'][string];
      slot: IntentSlotState;
    },
    committedUserText: string,
    explicitRequest: boolean,
  ): DialogueDecision {
    const { definition, slot } = target;

    return {
      action: 'confirm',
      reason: explicitRequest
        ? 'slot_confirmation_requested'
        : 'slot_capture_requires_confirmation',
      slotKey: definition.key,
      responseText: this.buildConfirmationPrompt(
        definition.key,
        definition.label,
        slot,
      ),
      committedUserText,
      shouldReason: true,
    };
  }

  private isSlotActionReady(slot: IntentSlotState | undefined): boolean {
    if (!slot?.value) {
      return false;
    }

    return slot.status === 'confirmed' && !slot.needsConfirmation;
  }

  private buildConfirmationPrompt(
    slotKey: string,
    label: string,
    slot: IntentSlotState,
  ): string {
    const spokenValue = this.formatSlotValueForSpeech(slotKey, slot);
    return `I have the ${label} as ${spokenValue}. Is that right?`;
  }

  private formatSlotValueForSpeech(
    slotKey: string,
    slot: IntentSlotState,
  ): string {
    const value = slot.value ?? '';
    switch (slotKey) {
      case 'vehicleRegistration':
        return value.split('').join(' ');
      case 'phoneNumber':
        return (slot.canonicalValue ?? value).split('').join(' ');
      default:
        return value;
    }
  }
}
