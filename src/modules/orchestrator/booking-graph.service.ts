import { Injectable } from '@nestjs/common';
import { END, MemorySaver, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { AppError } from '../../common/types/errors';
import {
  DialogueAction,
  IntentSlotState,
  IntentSlotStatus,
  SessionConversationState,
} from '../../common/types/conversation.types';
import { ChatMessage } from '../../common/types/reasoning.types';
import { SessionState } from '../../common/types/session.types';
import { nowIso } from '../../common/utils/timing';
import {
  ConversationProfile,
  ConversationProfileRegistryService,
} from '../conversation-engine/conversation-profile.registry';
import { ReasoningService } from '../reasoning/reasoning.service';
import { TaskConfig } from '../tasks/task-config.types';

const bookingSlotKeys = [
  'serviceType',
  'vehicleRegistration',
  'customerName',
  'phoneNumber',
  'customerEmail',
  'preferredDate',
  'preferredTime',
  'issueDescription',
] as const;

type BookingSlotKey = (typeof bookingSlotKeys)[number];

const bookingSlotKeySchema = z.enum(bookingSlotKeys);
const bookingUserMoveSchema = z.enum([
  'provide_info',
  'confirm',
  'deny',
  'correct',
  'readback_request',
  'end',
  'unknown',
]);
const bookingNextActionSchema = z.enum(['ask', 'confirm', 'act', 'end']);
const bookingConversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.string(),
  turnId: z.string().optional(),
});
const bookingGraphSlotSchema = z.object({
  value: z.string().nullable().default(null),
  canonicalValue: z.string().nullable().default(null),
  status: z.enum(['missing', 'provisional', 'confirmed']).default('missing'),
  confidence: z.number().min(0).max(1).default(0),
  needsConfirmation: z.boolean().default(false),
});
const bookingSlotsSchema = z.object({
  serviceType: bookingGraphSlotSchema,
  vehicleRegistration: bookingGraphSlotSchema,
  customerName: bookingGraphSlotSchema,
  phoneNumber: bookingGraphSlotSchema,
  customerEmail: bookingGraphSlotSchema,
  preferredDate: bookingGraphSlotSchema,
  preferredTime: bookingGraphSlotSchema,
  issueDescription: bookingGraphSlotSchema,
});
const extractedSlotUpdateSchema = z.object({
  slotKey: bookingSlotKeySchema,
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.8),
});
const extractedTurnSchema = z.object({
  userMove: bookingUserMoveSchema.default('unknown'),
  requestedSlotKey: bookingSlotKeySchema.nullable().default(null),
  slotUpdates: z.array(extractedSlotUpdateSchema).default([]),
  wantsEndCall: z.boolean().default(false),
  notes: z.string().default(''),
});

const bookingGraphStateSchema = new StateSchema({
  sessionId: z.string().default(''),
  taskKey: z.string().default('car_booking_receptionist'),
  turnId: z.string().default(''),
  currentUserText: z.string().default(''),
  history: z.array(bookingConversationTurnSchema).default([]),
  slots: bookingSlotsSchema.default({
    serviceType: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    vehicleRegistration: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    customerName: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    phoneNumber: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    customerEmail: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    preferredDate: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    preferredTime: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
    issueDescription: {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    },
  }),
  userMove: bookingUserMoveSchema.default('unknown'),
  requestedSlotKey: bookingSlotKeySchema.nullable().default(null),
  extractedUpdates: z.array(extractedSlotUpdateSchema).default([]),
  focusSlot: bookingSlotKeySchema.nullable().default(null),
  confirmationTarget: bookingSlotKeySchema.nullable().default(null),
  nextAction: bookingNextActionSchema.default('ask'),
  debugReason: z.string().default(''),
  replyText: z.string().nullable().default(null),
  endCall: z.boolean().default(false),
});

type BookingGraphStateValue = typeof bookingGraphStateSchema.State;
type BookingGraphSlotState = BookingGraphStateValue['slots'][BookingSlotKey];
type BookingGraphTurnExtraction = z.infer<typeof extractedTurnSchema>;
type BookingGraphTurnDecision = {
  action: DialogueAction;
  reason: string;
  slotKey?: BookingSlotKey;
  shouldReason: true;
};

export interface BookingGraphTurnResult {
  replyText: string;
  decision: BookingGraphTurnDecision;
  state: BookingGraphStateValue;
  endCall: boolean;
}

@Injectable()
export class BookingGraphService {
  private readonly graph = new StateGraph(bookingGraphStateSchema)
    .addNode('extract_turn', (state) => this.extractTurn(state))
    .addNode('apply_turn', (state) => this.applyTurn(state))
    .addNode('generate_reply', (state) => this.generateReply(state))
    .addEdge(START, 'extract_turn')
    .addEdge('extract_turn', 'apply_turn')
    .addEdge('apply_turn', 'generate_reply')
    .addEdge('generate_reply', END)
    .compile({ checkpointer: new MemorySaver() });

  constructor(
    private readonly reasoning: ReasoningService,
    private readonly profiles: ConversationProfileRegistryService,
  ) {}

  async processTurn(
    session: SessionState,
    task: TaskConfig,
    turnId: string,
    userText: string,
  ): Promise<BookingGraphTurnResult> {
    const state = (await this.graph.invoke(
      {
        sessionId: session.id,
        taskKey: task.key,
        turnId,
        currentUserText: userText,
        history: session.history,
      },
      {
        configurable: {
          thread_id: session.id,
          task,
        },
      },
    )) as BookingGraphStateValue;

    this.syncSessionConversation(session, state);

    return {
      replyText:
        state.replyText?.trim() ||
        'What detail would you like to add next?',
      decision: {
        action: state.nextAction === 'end' ? 'act' : state.nextAction,
        reason: state.debugReason || 'booking_graph_completed_turn',
        slotKey: state.focusSlot ?? undefined,
        shouldReason: true,
      },
      state,
      endCall: state.endCall,
    };
  }

  private async extractTurn(
    state: BookingGraphStateValue,
  ): Promise<Partial<BookingGraphStateValue>> {
    const quickMove = this.classifyQuickMove(
      state.currentUserText,
      state.confirmationTarget,
    );
    if (quickMove) {
      return quickMove;
    }

    try {
      const response = await this.reasoning.generate({
        messages: this.buildExtractionMessages(state),
        temperature: 0.05,
        maxTokens: 240,
      });

      const parsed = this.parseJson(response.text, extractedTurnSchema);
      return {
        userMove: parsed.userMove,
        requestedSlotKey: parsed.requestedSlotKey,
        extractedUpdates: parsed.slotUpdates,
      };
    } catch {
      return {
        userMove: 'unknown',
        requestedSlotKey: null,
        extractedUpdates: [],
      };
    }
  }

  private async applyTurn(
    state: BookingGraphStateValue,
  ): Promise<Partial<BookingGraphStateValue>> {
    const profile = this.profiles.getProfileForTask(state.taskKey);
    const slots = this.cloneSlots(state.slots);
    let focusSlot = state.focusSlot;
    let confirmationTarget = state.confirmationTarget;
    let nextAction: BookingGraphStateValue['nextAction'] = 'ask';
    let debugReason = 'booking_graph_missing_required_slot';
    let endCall = state.userMove === 'end';

    if (state.requestedSlotKey) {
      if (slots[state.requestedSlotKey].value) {
        focusSlot = state.requestedSlotKey;
        confirmationTarget = state.requestedSlotKey;
        nextAction = 'confirm';
        debugReason = 'slot_confirmation_requested';
      } else {
        focusSlot = state.requestedSlotKey;
        confirmationTarget = null;
        nextAction = 'ask';
        debugReason = 'requested_slot_missing';
      }

      return {
        slots,
        focusSlot,
        confirmationTarget,
        nextAction,
        debugReason,
        endCall,
      };
    }

    if (confirmationTarget && state.userMove === 'confirm') {
      const targetSlot = slots[confirmationTarget];
      if (targetSlot.value) {
        slots[confirmationTarget] = {
          ...targetSlot,
          status: 'confirmed',
          needsConfirmation: false,
          confidence: Math.max(targetSlot.confidence, 0.95),
        };
      }
      confirmationTarget = null;
    } else if (confirmationTarget && state.userMove === 'deny') {
      slots[confirmationTarget] = this.emptySlot();
      focusSlot = confirmationTarget;
      nextAction = 'ask';
      debugReason = 'slot_confirmation_rejected';
      return {
        slots,
        focusSlot,
        confirmationTarget: null,
        nextAction,
        debugReason,
        endCall,
      };
    }

    for (const update of state.extractedUpdates) {
      const normalized = this.normalizeSlotValue(update.slotKey, update.value);
      if (!normalized) {
        continue;
      }

      const needsConfirmation = this.slotNeedsConfirmation(
        profile,
        update.slotKey,
      );
      slots[update.slotKey] = {
        value: normalized.value,
        canonicalValue: normalized.canonicalValue,
        confidence: update.confidence,
        status: needsConfirmation ? 'provisional' : 'confirmed',
        needsConfirmation,
      };

      if (needsConfirmation) {
        confirmationTarget = update.slotKey;
        focusSlot = update.slotKey;
      }
    }

    if (
      confirmationTarget &&
      slots[confirmationTarget].value &&
      slots[confirmationTarget].needsConfirmation
    ) {
      nextAction = 'confirm';
      focusSlot = confirmationTarget;
      debugReason = 'slot_capture_requires_confirmation';
      return {
        slots,
        focusSlot,
        confirmationTarget,
        nextAction,
        debugReason,
        endCall,
      };
    }

    const nextMissing = this.findNextMissingActionSlot(slots, profile);
    if (nextMissing) {
      nextAction = 'ask';
      focusSlot = nextMissing;
      debugReason = 'missing_action_ready_slot';
      return {
        slots,
        focusSlot,
        confirmationTarget: null,
        nextAction,
        debugReason,
        endCall,
      };
    }

    nextAction = endCall ? 'end' : 'act';
    focusSlot = null;
    confirmationTarget = null;
    debugReason = endCall ? 'caller_finished' : 'minimum_booking_context_ready';

    return {
      slots,
      focusSlot,
      confirmationTarget,
      nextAction,
      debugReason,
      endCall,
    };
  }

  private async generateReply(
    state: BookingGraphStateValue,
  ): Promise<Partial<BookingGraphStateValue>> {
    const task: TaskConfig = {
      key: state.taskKey,
      name: 'Car Booking Receptionist',
      systemPrompt:
        'You are a warm, efficient vehicle service receptionist. Help callers book a service and keep the conversation focused on the booking.',
      behaviorGuidelines: [
        'Return only user-facing plain text.',
        'Keep spoken replies short, clear, and helpful.',
        'Do not use markdown, JSON, code blocks, tool call syntax, SSML, or stage directions.',
        'Say times naturally.',
      ],
      allowedTools: [],
      responsePolicy: {
        style: 'warm, concise, spoken receptionist',
        responseLengthMode: 'short',
        hardMaxResponseChars: 320,
        plainTextOnly: true,
      },
      memoryPolicy: {
        enabled: false,
        maxFactsInPrompt: 0,
        writePolicy: 'Session memory is disabled in this transport-only build.',
      },
    };

    try {
      const response = await this.reasoning.generate({
        messages: this.buildReplyMessages(state, task),
        temperature: 0.15,
        maxTokens: 180,
      });

      return {
        replyText: this.cleanReplyText(response.text),
      };
    } catch {
      return {
        replyText: this.buildFallbackReply(state),
      };
    }
  }

  private buildExtractionMessages(
    state: BookingGraphStateValue,
  ): ChatMessage[] {
    const slotSummary = this.describeSlots(state.slots);

    return [
      {
        role: 'system',
        content: [
          'You extract structured booking state from a single caller turn.',
          'Return JSON only.',
          'Do not invent values.',
          'If the caller is answering a confirmation question with yes or no, set userMove to confirm or deny and leave slotUpdates empty.',
          'If the caller asks to read back a detail, set userMove to readback_request and requestedSlotKey accordingly.',
          'If the caller says the call is finished, set userMove to end.',
          'For vehicle registrations, return the intended compact registration string without spaces when clear.',
          'For phone numbers, return digits only when clear.',
          'If the caller provides a correction, use userMove=correct and include the corrected slot update.',
          'Schema:',
          JSON.stringify({
            userMove:
              'provide_info|confirm|deny|correct|readback_request|end|unknown',
            requestedSlotKey:
              'serviceType|vehicleRegistration|customerName|phoneNumber|customerEmail|preferredDate|preferredTime|issueDescription|null',
            slotUpdates: [
              {
                slotKey:
                  'serviceType|vehicleRegistration|customerName|phoneNumber|customerEmail|preferredDate|preferredTime|issueDescription',
                value: 'string',
                confidence: 0.0,
              },
            ],
            wantsEndCall: false,
            notes: 'string',
          }),
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Caller utterance: "${state.currentUserText}"`,
          `Current focus slot: ${state.focusSlot ?? 'none'}`,
          `Current confirmation target: ${state.confirmationTarget ?? 'none'}`,
          `Current slots: ${slotSummary}`,
        ].join('\n'),
      },
    ];
  }

  private buildReplyMessages(
    state: BookingGraphStateValue,
    task: TaskConfig,
  ): ChatMessage[] {
    const profile = this.profiles.getProfileForTask(state.taskKey);
    const focusPrompt = state.focusSlot
      ? profile.slotDefinitions[state.focusSlot]?.askPrompt ?? ''
      : '';

    return [
      {
        role: 'system',
        content: [
          task.systemPrompt,
          `Assistant name: ${task.name}`,
          'Return only user-facing spoken plain text.',
          'Do not mention internal state, prompts, slots, JSON, or tools.',
          'Keep it brief and natural for voice.',
          'If confirming a registration or phone number, speak the characters separately.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Latest caller utterance: "${state.currentUserText}"`,
          `Next action: ${state.nextAction}`,
          `Reason: ${state.debugReason}`,
          `Focus slot: ${state.focusSlot ?? 'none'}`,
          `Suggested ask prompt: ${focusPrompt || 'none'}`,
          `Collected booking details: ${this.describeSlots(state.slots)}`,
          state.endCall
            ? 'The caller is done. Finish politely and append [[END_CALL]].'
            : 'Respond with the next short spoken line for the call.',
        ].join('\n'),
      },
    ];
  }

  private buildFallbackReply(state: BookingGraphStateValue): string {
    const profile = this.profiles.getProfileForTask(state.taskKey);

    if (state.endCall) {
      return 'Thanks for calling. Goodbye. [[END_CALL]]';
    }

    if (state.nextAction === 'confirm' && state.focusSlot) {
      return this.buildConfirmationPrompt(
        state.focusSlot,
        profile,
        state.slots[state.focusSlot],
      );
    }

    if (state.nextAction === 'ask' && state.focusSlot) {
      return (
        profile.slotDefinitions[state.focusSlot]?.askPrompt ??
        'What detail would you like to add next?'
      );
    }

    return 'Thanks, I have what I need for the booking. Is there anything else I can help with?';
  }

  private buildConfirmationPrompt(
    slotKey: BookingSlotKey,
    profile: ConversationProfile,
    slot: BookingGraphSlotState,
  ): string {
    const label = profile.slotDefinitions[slotKey]?.label ?? slotKey;
    return `I have the ${label} as ${this.formatSlotValueForSpeech(slotKey, slot)}. Is that right?`;
  }

  private cleanReplyText(text: string): string {
    return text
      .replace(/\r/g, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseJson<T>(text: string, schema: z.ZodSchema<T>): T {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const candidates = [
      cleaned,
      cleaned.match(/\{[\s\S]*\}/)?.[0],
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      try {
        return schema.parse(JSON.parse(candidate));
      } catch {
        continue;
      }
    }

    throw new AppError(
      'BOOKING_GRAPH_PARSE_FAILED',
      'The booking graph could not parse structured model output.',
      { text },
    );
  }

  private classifyQuickMove(
    text: string,
    confirmationTarget: BookingSlotKey | null,
  ): Partial<BookingGraphStateValue> | null {
    const normalized = text
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:]/g, '')
      .replace(/\s+/g, ' ');
    if (!normalized) {
      return null;
    }

    if (
      confirmationTarget &&
      /^(yes|yes that'?s correct|yes that is right|that is correct|that'?s right|it'?s right|correct)$/i.test(
        normalized,
      )
    ) {
      return {
        userMove: 'confirm',
        requestedSlotKey: null,
        extractedUpdates: [],
      };
    }

    if (
      confirmationTarget &&
      /^(no|nope|no that'?s not right|no it'?s not|not correct|not entirely)$/i.test(
        normalized,
      )
    ) {
      return {
        userMove: 'deny',
        requestedSlotKey: null,
        extractedUpdates: [],
      };
    }

    if (
      /\b(read back|readback|repeat|say back|confirm)\b/i.test(normalized) &&
      /\b(rego|registration|plate|regal)\b/i.test(normalized)
    ) {
      return {
        userMove: 'readback_request',
        requestedSlotKey: 'vehicleRegistration',
        extractedUpdates: [],
      };
    }

    if (
      /\b(bye|goodbye|no thanks|nothing else|that is all|that\'s all)\b/i.test(
        normalized,
      )
    ) {
      return {
        userMove: 'end',
        requestedSlotKey: null,
        extractedUpdates: [],
      };
    }

    return null;
  }

  private normalizeSlotValue(
    slotKey: BookingSlotKey,
    rawValue: string,
  ): { value: string; canonicalValue: string | null } | null {
    const trimmed = rawValue.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      return null;
    }

    switch (slotKey) {
      case 'vehicleRegistration': {
        const canonicalValue = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!canonicalValue) {
          return null;
        }
        return {
          value: canonicalValue,
          canonicalValue,
        };
      }
      case 'phoneNumber': {
        const digits = trimmed.replace(/\D/g, '');
        if (!digits) {
          return null;
        }
        return {
          value: this.formatPhoneNumber(digits),
          canonicalValue: digits,
        };
      }
      case 'customerEmail':
        return {
          value: trimmed.toLowerCase(),
          canonicalValue: trimmed.toLowerCase(),
        };
      case 'serviceType':
      case 'preferredDate':
      case 'preferredTime':
      case 'issueDescription':
        return {
          value: trimmed.toLowerCase(),
          canonicalValue: trimmed.toLowerCase(),
        };
      case 'customerName':
      default:
        return {
          value: trimmed,
          canonicalValue: trimmed,
        };
    }
  }

  private formatPhoneNumber(digits: string): string {
    if (digits.length === 10) {
      return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    }
    return digits;
  }

  private slotNeedsConfirmation(
    profile: ConversationProfile,
    slotKey: BookingSlotKey,
  ): boolean {
    return Boolean(profile.slotDefinitions[slotKey]?.confirmationRequired);
  }

  private findNextMissingActionSlot(
    slots: BookingGraphStateValue['slots'],
    profile: ConversationProfile,
  ): BookingSlotKey | null {
    for (const slotKey of profile.actionReadySlotKeys) {
      const typedKey = slotKey as BookingSlotKey;
      if (!slots[typedKey]?.value) {
        return typedKey;
      }
    }
    return null;
  }

  private formatSlotValueForSpeech(
    slotKey: BookingSlotKey,
    slot: BookingGraphSlotState,
  ): string {
    const rawValue = slot.canonicalValue ?? slot.value ?? '';
    if (!rawValue) {
      return 'missing';
    }

    if (slotKey === 'vehicleRegistration' || slotKey === 'phoneNumber') {
      return rawValue.split('').join(' ');
    }

    return slot.value ?? rawValue;
  }

  private describeSlots(slots: BookingGraphStateValue['slots']): string {
    return JSON.stringify(
      Object.fromEntries(
        bookingSlotKeys.map((slotKey) => [
          slotKey,
          {
            value: slots[slotKey].value,
            status: slots[slotKey].status,
            needsConfirmation: slots[slotKey].needsConfirmation,
          },
        ]),
      ),
    );
  }

  private cloneSlots(
    slots: BookingGraphStateValue['slots'],
  ): BookingGraphStateValue['slots'] {
    return {
      serviceType: { ...slots.serviceType },
      vehicleRegistration: { ...slots.vehicleRegistration },
      customerName: { ...slots.customerName },
      phoneNumber: { ...slots.phoneNumber },
      customerEmail: { ...slots.customerEmail },
      preferredDate: { ...slots.preferredDate },
      preferredTime: { ...slots.preferredTime },
      issueDescription: { ...slots.issueDescription },
    };
  }

  private emptySlot(): BookingGraphSlotState {
    return {
      value: null,
      canonicalValue: null,
      status: 'missing',
      confidence: 0,
      needsConfirmation: false,
    };
  }

  private syncSessionConversation(
    session: SessionState,
    state: BookingGraphStateValue,
  ): void {
    const profile = this.profiles.getProfileForTask(state.taskKey);
    const syncedSlots = Object.fromEntries(
      bookingSlotKeys.map((slotKey) => {
        const definition = profile.slotDefinitions[slotKey];
        const slot = state.slots[slotKey];
        return [
          slotKey,
          {
            key: slotKey,
            label: definition?.label ?? slotKey,
            value: slot.value,
            canonicalValue: slot.canonicalValue,
            confidence: slot.confidence,
            status: this.toIntentSlotStatus(slot.status),
            needsConfirmation: slot.needsConfirmation,
            updatedAt: nowIso(),
            sourceFragmentIds: [],
          } satisfies IntentSlotState,
        ];
      }),
    ) as SessionConversationState['liveIntent']['slots'];

    session.conversation = {
      transcriptFragments: session.conversation?.transcriptFragments ?? [],
      liveIntent: {
        profileKey: 'car_booking_receptionist',
        version: (session.conversation?.liveIntent.version ?? 0) + 1,
        intent: {
          name: profile.intentName,
          confidence: 1,
          status: 'usable',
          updatedAt: nowIso(),
        },
        slots: syncedSlots,
        floor: {
          state: 'assistant_waiting',
          stability: 1,
          lastUserActivityAt: nowIso(),
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
          slotKey: state.focusSlot,
          action: state.nextAction === 'end' ? 'act' : state.nextAction,
          updatedAt: nowIso(),
        },
        latestCommittedThought: state.currentUserText,
      },
      lastDecision: {
        action: state.nextAction === 'end' ? 'act' : state.nextAction,
        reason: state.debugReason,
        slotKey: state.focusSlot ?? undefined,
        shouldReason: true,
        at: nowIso(),
        consumed: false,
      },
    };
  }

  private toIntentSlotStatus(status: BookingGraphSlotState['status']): IntentSlotStatus {
    switch (status) {
      case 'confirmed':
        return 'confirmed';
      case 'provisional':
        return 'provisional';
      default:
        return 'missing';
    }
  }
}
