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

    const lower = state.pendingThought.text.toLowerCase();
    if (
      /^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/.test(
        lower,
      )
    ) {
      return {
        action: 'ignore',
        reason: 'filler_only',
      };
    }

    const incompleteReason = state.pendingThought.incompleteReason;
    const delayMs = this.resolveDelayMs(profile, incompleteReason);

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
      /^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/.test(
        committedUserText.toLowerCase(),
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
        profile,
        committedUserText,
        true,
      );
    }

    const slotNeedingConfirmation = this.findNextSlotNeedingConfirmation(
      state,
      profile,
    );
    if (slotNeedingConfirmation) {
      return this.buildConfirmationDecision(
        slotNeedingConfirmation,
        profile,
        committedUserText,
        false,
      );
    }

    const correctedSlot = this.findCorrectedSlot(state, profile);
    if (correctedSlot) {
      return {
        action: 'confirm',
        reason: 'slot_corrected',
        slotKey: correctedSlot.key,
        responseText: `Thanks. Just to confirm, the ${correctedSlot.label} is ${correctedSlot.value}.`,
        committedUserText,
        shouldReason: true,
      };
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
      const definition = profile.slotDefinitions[slotKey];
      const slot = state.slots[slotKey];
      return this.isSlotActionReady(definition, slot);
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

        return !this.isSlotActionReady(definition, slot);
      });
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

    return {
      definition,
      slot,
    };
  }

  private buildConfirmationDecision(
    target: {
      definition: ConversationProfile['slotDefinitions'][string];
      slot: IntentSlotState;
    },
    profile: ConversationProfile,
    committedUserText: string,
    explicitRequest: boolean,
  ): DialogueDecision {
    const { definition, slot } = target;

    if (this.shouldRecaptureSlot(definition.key, slot)) {
      return {
        action: 'ask',
        reason: explicitRequest
          ? 'slot_confirmation_requested_but_capture_weak'
          : 'slot_capture_requires_recapture',
        slotKey: definition.key,
        responseText: this.buildRecapturePrompt(definition, slot),
        committedUserText,
        shouldReason: true,
      };
    }

    return {
      action: 'confirm',
      reason: explicitRequest
        ? 'slot_confirmation_requested'
        : 'slot_capture_requires_confirmation',
      slotKey: definition.key,
      responseText: this.buildConfirmationPrompt(
        definition,
        slot,
        explicitRequest,
      ),
      committedUserText,
      shouldReason: true,
    };
  }

  private isSlotActionReady(
    definition: ConversationProfile['slotDefinitions'][string] | undefined,
    slot: IntentSlotState | undefined,
  ): boolean {
    if (!definition || !slot?.value) {
      return false;
    }

    return slot.status === 'confirmed' && !slot.needsConfirmation;
  }

  private shouldRecaptureSlot(slotKey: string, slot: IntentSlotState): boolean {
    if (!slot.value) {
      return true;
    }

    switch (slotKey) {
      case 'vehicleRegistration':
        return slot.confidence < 0.8 || slot.value.length < 4;
      case 'phoneNumber':
        return slot.confidence < 0.86 || (slot.canonicalValue?.length ?? 0) < 8;
      case 'customerEmail':
        return slot.confidence < 0.9 || !slot.value.includes('@');
      case 'customerName':
        return slot.confidence < 0.76 || slot.value.length < 2;
      default:
        return slot.confidence < 0.7;
    }
  }

  private buildConfirmationPrompt(
    definition: ConversationProfile['slotDefinitions'][string],
    slot: IntentSlotState,
    explicitRequest: boolean,
  ): string {
    const formattedValue = this.formatSlotValueForSpeech(definition.key, slot);

    if (
      explicitRequest &&
      slot.status === 'confirmed' &&
      !slot.needsConfirmation
    ) {
      return `I have the ${definition.label} as ${formattedValue}.`;
    }

    return `I heard the ${definition.label} as ${formattedValue}. Is that right?`;
  }

  private buildRecapturePrompt(
    definition: ConversationProfile['slotDefinitions'][string],
    slot: IntentSlotState,
  ): string {
    const formattedValue = slot.value
      ? this.formatSlotValueForSpeech(definition.key, slot)
      : null;
    if (!formattedValue) {
      return definition.askPrompt;
    }

    switch (definition.key) {
      case 'vehicleRegistration':
        return `I only caught ${formattedValue} so far. Please say the full vehicle registration one character at a time.`;
      case 'phoneNumber':
        return `I only caught ${formattedValue} so far. Please say the full phone number one digit at a time.`;
      case 'customerEmail':
        return `I only caught ${formattedValue} so far. Please say the full email address slowly, for example name at gmail dot com.`;
      case 'customerName':
        return `I only caught ${formattedValue} so far. Please say or spell your full name again.`;
      default:
        return definition.askPrompt;
    }
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
        return slot.canonicalValue
          ? slot.canonicalValue.split('').join(' ')
          : value;
      default:
        return value;
    }
  }

  private resolveDelayMs(
    profile: ConversationProfile,
    incompleteReason: string | null,
  ): number {
    if (!incompleteReason) {
      return profile.defaultHoldMs;
    }

    if (
      /(?:registration|phone|email|name)_capture_incomplete/.test(
        incompleteReason,
      )
    ) {
      return Math.max(profile.incompleteHoldMs, 800);
    }

    return profile.incompleteHoldMs;
  }
}
