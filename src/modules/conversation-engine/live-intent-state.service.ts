import { Injectable } from '@nestjs/common';
import {
  IntentSlotState,
  LiveIntentState,
  SemanticPatch,
  SessionConversationState,
} from '../../common/types/conversation.types';
import { SessionState } from '../../common/types/session.types';
import { nowIso } from '../../common/utils/timing';
import {
  ConversationProfile,
  ConversationProfileRegistryService,
} from './conversation-profile.registry';

@Injectable()
export class LiveIntentStateService {
  constructor(
    private readonly profiles: ConversationProfileRegistryService,
  ) {}

  ensureConversationState(session: SessionState): SessionConversationState {
    if (!session.conversation) {
      const profile = this.profiles.getProfileForTask(session.taskKey);
      session.conversation = {
        transcriptFragments: [],
        liveIntent: this.createEmptyLiveIntent(profile),
      };
    }

    return session.conversation;
  }

  createEmptyLiveIntent(profile: ConversationProfile): LiveIntentState {
    const now = nowIso();
    const slots = Object.fromEntries(
      Object.values(profile.slotDefinitions).map((slot) => [
        slot.key,
        {
          key: slot.key,
          label: slot.label,
          value: null,
          canonicalValue: null,
          confidence: 0,
          status: 'missing',
          needsConfirmation: false,
          updatedAt: null,
          sourceFragmentIds: [],
        } satisfies IntentSlotState,
      ]),
    );

    return {
      profileKey: profile.key,
      version: 0,
      intent: {
        name: null,
        confidence: 0,
        status: 'empty',
        updatedAt: null,
      },
      slots,
      floor: {
        state: 'assistant_waiting',
        stability: 0,
        lastUserActivityAt: null,
      },
      pendingThought: {
        fragmentIds: [],
        text: '',
        startedAt: null,
        updatedAt: null,
        status: 'idle',
        incompleteReason: null,
        holdUntil: null,
      },
      prompt: {
        slotKey: null,
        action: null,
        updatedAt: null,
      },
      latestCommittedThought: null,
    };
  }

  applyPatches(
    session: SessionState,
    patches: SemanticPatch[],
  ): LiveIntentState {
    const conversation = this.ensureConversationState(session);
    const state = conversation.liveIntent;

    for (const patch of patches) {
      switch (patch.type) {
        case 'append_thought_fragment': {
          state.pendingThought.fragmentIds.push(patch.fragmentId);
          state.pendingThought.text = [state.pendingThought.text, patch.text]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          state.pendingThought.startedAt ??= patch.at;
          state.pendingThought.updatedAt = patch.at;
          if (state.pendingThought.status === 'idle') {
            state.pendingThought.status = 'forming';
          }
          break;
        }
        case 'set_intent': {
          state.intent = {
            name: patch.intentName,
            confidence: patch.confidence,
            status: patch.status,
            updatedAt: patch.at,
          };
          break;
        }
        case 'upsert_slot': {
          const current =
            state.slots[patch.slotKey] ??
            ({
              key: patch.slotKey,
              label: patch.slotKey,
              value: null,
              canonicalValue: null,
              confidence: 0,
              status: 'missing',
              needsConfirmation: false,
              updatedAt: null,
              sourceFragmentIds: [],
            } satisfies IntentSlotState);
          const isCorrection =
            current.value !== null &&
            current.canonicalValue !== null &&
            current.canonicalValue !== (patch.canonicalValue ?? patch.value);

          state.slots[patch.slotKey] = {
            ...current,
            value: patch.value,
            canonicalValue: patch.canonicalValue ?? patch.value,
            confidence: patch.confidence,
            status:
              patch.status === 'confirmed' && isCorrection
                ? 'corrected'
                : patch.status,
            needsConfirmation: patch.needsConfirmation ?? current.needsConfirmation,
            updatedAt: patch.at,
            sourceFragmentIds: [
              ...new Set([...current.sourceFragmentIds, patch.fragmentId]),
            ],
          };
          break;
        }
        case 'clear_slot': {
          const current =
            state.slots[patch.slotKey] ??
            ({
              key: patch.slotKey,
              label: patch.slotKey,
              value: null,
              canonicalValue: null,
              confidence: 0,
              status: 'missing',
              needsConfirmation: false,
              updatedAt: null,
              sourceFragmentIds: [],
            } satisfies IntentSlotState);

          state.slots[patch.slotKey] = {
            ...current,
            value: null,
            canonicalValue: null,
            confidence: 0,
            status: 'missing',
            needsConfirmation: false,
            updatedAt: patch.at,
            sourceFragmentIds: [],
          };
          break;
        }
        case 'confirm_slot': {
          const current = state.slots[patch.slotKey];
          if (!current?.value) {
            break;
          }

          state.slots[patch.slotKey] = {
            ...current,
            status: 'confirmed',
            needsConfirmation: false,
            updatedAt: patch.at,
          };
          break;
        }
        case 'set_floor': {
          state.floor = {
            state: patch.state,
            stability: patch.stability,
            lastUserActivityAt: patch.at,
          };
          break;
        }
        case 'mark_pending_thought': {
          state.pendingThought.status = patch.status;
          state.pendingThought.incompleteReason = patch.incompleteReason ?? null;
          state.pendingThought.holdUntil = patch.holdUntil ?? null;
          break;
        }
        case 'clear_pending_thought': {
          state.latestCommittedThought = state.pendingThought.text || null;
          state.pendingThought = {
            fragmentIds: [],
            text: '',
            startedAt: null,
            updatedAt: null,
            status: 'idle',
            incompleteReason: null,
            holdUntil: null,
          };
          break;
        }
        case 'set_prompt': {
          state.prompt = {
            slotKey: patch.slotKey,
            action: patch.action,
            updatedAt: patch.at,
          };
          break;
        }
      }
    }

    state.version += 1;
    session.updatedAt = nowIso();
    return state;
  }

  promotePendingThoughtSlots(
    session: SessionState,
    profile: ConversationProfile,
  ): LiveIntentState {
    const conversation = this.ensureConversationState(session);
    const state = conversation.liveIntent;
    const pendingFragmentIds = new Set(state.pendingThought.fragmentIds);

    for (const slotKey of Object.keys(profile.slotDefinitions)) {
      const slot = state.slots[slotKey];
      if (!slot?.value) {
        continue;
      }

      if (
        slot.status === 'provisional' &&
        slot.sourceFragmentIds.some((fragmentId) => pendingFragmentIds.has(fragmentId))
      ) {
        const shouldAutoConfirm =
          slot.confidence >= this.getAutoConfirmThreshold(slotKey) &&
          !slot.needsConfirmation;

        slot.status = shouldAutoConfirm ? 'confirmed' : 'provisional';
        slot.updatedAt = nowIso();
      }
    }

    return state;
  }

  private getAutoConfirmThreshold(slotKey: string): number {
    switch (slotKey) {
      case 'vehicleRegistration':
        return 0.96;
      case 'phoneNumber':
        return 0.94;
      case 'customerEmail':
        return 0.96;
      case 'customerName':
        return 0.88;
      default:
        return 0.7;
    }
  }
}
