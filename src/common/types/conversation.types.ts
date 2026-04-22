export type ConversationProfileKey = 'generic' | 'car_booking_receptionist';

export interface TranscriptFragment {
  id: string;
  sessionId: string;
  text: string;
  normalizedText: string;
  receivedAt: string;
  confidence: number | null;
  isInterrupting: boolean;
  source: 'stt';
}

export type IntentStatus = 'empty' | 'forming' | 'usable' | 'confirmed';

export type IntentSlotStatus =
  | 'missing'
  | 'provisional'
  | 'confirmed'
  | 'corrected'
  | 'conflicted';

export interface IntentSlotState {
  key: string;
  label: string;
  value: string | null;
  canonicalValue: string | null;
  confidence: number;
  status: IntentSlotStatus;
  needsConfirmation: boolean;
  updatedAt: string | null;
  sourceFragmentIds: string[];
}

export interface PendingThoughtState {
  fragmentIds: string[];
  text: string;
  startedAt: string | null;
  updatedAt: string | null;
  status: 'idle' | 'forming' | 'ready';
  incompleteReason: string | null;
  holdUntil: string | null;
}

export interface LiveIntentState {
  profileKey: ConversationProfileKey;
  version: number;
  intent: {
    name: string | null;
    confidence: number;
    status: IntentStatus;
    updatedAt: string | null;
  };
  slots: Record<string, IntentSlotState>;
  floor: {
    state:
      | 'user_thinking'
      | 'user_done'
      | 'assistant_speaking'
      | 'assistant_waiting';
    stability: number;
    lastUserActivityAt: string | null;
  };
  pendingThought: PendingThoughtState;
  prompt: {
    slotKey: string | null;
    action: DialogueAction | null;
    updatedAt: string | null;
  };
  latestCommittedThought: string | null;
}

export type SemanticPatch =
  | {
      type: 'append_thought_fragment';
      fragmentId: string;
      text: string;
      at: string;
    }
  | {
      type: 'set_intent';
      intentName: string;
      confidence: number;
      status: IntentStatus;
      fragmentId: string;
      at: string;
    }
  | {
      type: 'upsert_slot';
      slotKey: string;
      value: string;
      canonicalValue?: string | null;
      confidence: number;
      status: IntentSlotStatus;
      needsConfirmation?: boolean;
      fragmentId: string;
      at: string;
    }
  | {
      type: 'clear_slot';
      slotKey: string;
      at: string;
    }
  | {
      type: 'confirm_slot';
      slotKey: string;
      at: string;
    }
  | {
      type: 'set_floor';
      state: LiveIntentState['floor']['state'];
      stability: number;
      at: string;
    }
  | {
      type: 'mark_pending_thought';
      status: PendingThoughtState['status'];
      incompleteReason?: string | null;
      holdUntil?: string | null;
    }
  | {
      type: 'clear_pending_thought';
    }
  | {
      type: 'set_prompt';
      slotKey: string | null;
      action: DialogueAction | null;
      at: string;
    };

export type DialogueAction =
  | 'wait'
  | 'ask'
  | 'act'
  | 'confirm'
  | 'ignore'
  | 'backchannel';

export interface DialogueDecision {
  action: DialogueAction;
  reason: string;
  delayMs?: number;
  slotKey?: string;
  responseText?: string;
  committedUserText?: string | null;
  shouldReason?: boolean;
}

export interface SessionConversationState {
  transcriptFragments: TranscriptFragment[];
  liveIntent: LiveIntentState;
  lastDecision?: DialogueDecision & {
    at: string;
    consumed: boolean;
  };
}
