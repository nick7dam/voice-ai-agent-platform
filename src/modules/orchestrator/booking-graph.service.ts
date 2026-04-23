import { Injectable } from '@nestjs/common';
import {
  END,
  MemorySaver,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph';
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

const numberWords = new Map<string, string>([
  ['zero', '0'],
  ['oh', '0'],
  ['o', '0'],
  ['one', '1'],
  ['won', '1'],
  ['two', '2'],
  ['to', '2'],
  ['too', '2'],
  ['three', '3'],
  ['four', '4'],
  ['for', '4'],
  ['fore', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['ate', '8'],
  ['nine', '9'],
]);

const looseNumberAliases = new Set([
  'o',
  'oh',
  'won',
  'to',
  'too',
  'for',
  'fore',
  'ate',
]);

const spokenLetterWords = new Map<string, string>([
  ['a', 'A'],
  ['ay', 'A'],
  ['b', 'B'],
  ['bee', 'B'],
  ['be', 'B'],
  ['c', 'C'],
  ['cee', 'C'],
  ['sea', 'C'],
  ['see', 'C'],
  ['d', 'D'],
  ['dee', 'D'],
  ['e', 'E'],
  ['ee', 'E'],
  ['f', 'F'],
  ['ef', 'F'],
  ['g', 'G'],
  ['gee', 'G'],
  ['h', 'H'],
  ['aitch', 'H'],
  ['haitch', 'H'],
  ['i', 'I'],
  ['eye', 'I'],
  ['j', 'J'],
  ['jay', 'J'],
  ['k', 'K'],
  ['kay', 'K'],
  ['l', 'L'],
  ['el', 'L'],
  ['m', 'M'],
  ['em', 'M'],
  ['n', 'N'],
  ['en', 'N'],
  ['p', 'P'],
  ['pee', 'P'],
  ['q', 'Q'],
  ['cue', 'Q'],
  ['queue', 'Q'],
  ['r', 'R'],
  ['ar', 'R'],
  ['are', 'R'],
  ['s', 'S'],
  ['ess', 'S'],
  ['t', 'T'],
  ['tee', 'T'],
  ['tea', 'T'],
  ['u', 'U'],
  ['you', 'U'],
  ['v', 'V'],
  ['vee', 'V'],
  ['w', 'W'],
  ['doubleu', 'W'],
  ['doubleyou', 'W'],
  ['x', 'X'],
  ['ex', 'X'],
  ['y', 'Y'],
  ['why', 'Y'],
  ['wye', 'Y'],
  ['z', 'Z'],
  ['zed', 'Z'],
  ['zee', 'Z'],
]);

const weekdayWords = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const monthWords = new Map<string, string>([
  ['january', 'january'],
  ['jan', 'january'],
  ['february', 'february'],
  ['feb', 'february'],
  ['march', 'march'],
  ['mar', 'march'],
  ['april', 'april'],
  ['apr', 'april'],
  ['may', 'may'],
  ['june', 'june'],
  ['jun', 'june'],
  ['july', 'july'],
  ['jul', 'july'],
  ['august', 'august'],
  ['aug', 'august'],
  ['september', 'september'],
  ['sep', 'september'],
  ['sept', 'september'],
  ['october', 'october'],
  ['oct', 'october'],
  ['november', 'november'],
  ['nov', 'november'],
  ['december', 'december'],
  ['dec', 'december'],
]);

const ordinalWords = new Map<string, number>([
  ['first', 1],
  ['second', 2],
  ['third', 3],
  ['fourth', 4],
  ['fifth', 5],
  ['sixth', 6],
  ['seventh', 7],
  ['eighth', 8],
  ['ninth', 9],
  ['tenth', 10],
  ['eleventh', 11],
  ['twelfth', 12],
  ['thirteenth', 13],
  ['fourteenth', 14],
  ['fifteenth', 15],
  ['sixteenth', 16],
  ['seventeenth', 17],
  ['eighteenth', 18],
  ['nineteenth', 19],
  ['twentieth', 20],
  ['thirtieth', 30],
]);

const tensWords = new Map<string, number>([
  ['twenty', 20],
  ['thirty', 30],
]);

const timeHourWords = new Map<string, number>([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
]);

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
type HeuristicTurnExtraction = {
  userMove: BookingGraphTurnExtraction['userMove'];
  requestedSlotKey: BookingGraphTurnExtraction['requestedSlotKey'];
  extractedUpdates: BookingGraphTurnExtraction['slotUpdates'];
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
        state.replyText?.trim() || 'What detail would you like to add next?',
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

    const heuristic = this.extractHeuristicTurn(state);
    if (
      heuristic.userMove !== 'unknown' ||
      heuristic.requestedSlotKey !== null ||
      heuristic.extractedUpdates.length > 0
    ) {
      return heuristic;
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
      return heuristic;
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
    const endCall = state.userMove === 'end';

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
      let normalized = this.normalizeSlotValue(update.slotKey, update.value);
      if (!normalized) {
        continue;
      }

      if (update.slotKey === 'vehicleRegistration') {
        normalized = this.mergeRegistrationContinuation(
          slots.vehicleRegistration,
          normalized,
          state.currentUserText,
        );
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
      ? (profile.slotDefinitions[state.focusSlot]?.askPrompt ?? '')
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
        'If Next action is confirm, do not ask for the same detail again. Read back the collected value and ask if it is right.',
        'If Next action is ask, ask only for the focus slot.',
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
    const candidates = [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]].filter(
      (candidate): candidate is string => Boolean(candidate),
    );

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

    const compact = normalized.replace(/[^a-z0-9]+/g, '');
    const affirmativeCompacts = new Set([
      'yes',
      'yeah',
      'yep',
      'correct',
      'right',
      'sure',
      'exactly',
      'yescorrect',
      'yesright',
      'yesthatscorrect',
      'yesthatiscorrect',
      'yesthatsright',
      'yesthatisright',
      'thatscorrect',
      'thatiscorrect',
      'thatsright',
      'thatisright',
      'itscorrect',
      'itiscorrect',
      'itsright',
      'itisright',
    ]);
    const negativeCompacts = new Set([
      'no',
      'nope',
      'incorrect',
      'wrong',
      'notcorrect',
      'notright',
      'notentirely',
      'noitsnot',
      'noitisnot',
      'noitsnotcorrect',
      'noitisnotcorrect',
      'thatswrong',
      'thatiswrong',
      'thatsnotcorrect',
      'thatisnotcorrect',
      'thatsnotright',
      'thatisnotright',
      'thatsnotit',
      'thatisnotit',
      'itswrong',
      'itiswrong',
      'itsnotcorrect',
      'itisnotcorrect',
      'itsnotright',
      'itisnotright',
    ]);
    const isAffirmative =
      /^(yes|yes that'?s correct|yes that is right|that is correct|that'?s right|it'?s right|correct)$/i.test(
        normalized,
      ) || affirmativeCompacts.has(compact);
    const isNegative =
      /^(no|nope|no that'?s not right|no it'?s not|not correct|not right|incorrect|wrong|that'?s wrong|that is wrong|not entirely)$/i.test(
        normalized,
      ) || negativeCompacts.has(compact);

    if (confirmationTarget && isAffirmative) {
      return {
        userMove: 'confirm',
        requestedSlotKey: null,
        extractedUpdates: [],
      };
    }

    if (confirmationTarget && isNegative) {
      return {
        userMove: 'deny',
        requestedSlotKey: null,
        extractedUpdates: [],
      };
    }

    if (isAffirmative || isNegative) {
      return {
        userMove: 'unknown',
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

  private extractHeuristicTurn(
    state: BookingGraphStateValue,
  ): HeuristicTurnExtraction {
    const text = state.currentUserText.trim();
    const lower = text.toLowerCase();
    const extractedUpdates: z.infer<typeof extractedSlotUpdateSchema>[] = [];

    const serviceType = this.detectServiceType(lower);
    if (serviceType) {
      extractedUpdates.push({
        slotKey: 'serviceType',
        value: serviceType,
        confidence: 0.92,
      });
    }

    const registration =
      state.focusSlot === 'vehicleRegistration' ||
      state.confirmationTarget === 'vehicleRegistration' ||
      /\b(rego|registration|plate)\b/i.test(lower)
        ? this.detectRegistration(text)
        : null;
    if (registration) {
      extractedUpdates.push({
        slotKey: 'vehicleRegistration',
        value: registration,
        confidence: 0.86,
      });
    }

    const phoneNumber =
      state.focusSlot === 'phoneNumber' ||
        /\b(phone|mobile|number)\b/i.test(lower)
        ? this.detectPhoneNumber(lower)
        : null;
    if (phoneNumber) {
      extractedUpdates.push({
        slotKey: 'phoneNumber',
        value: phoneNumber,
        confidence: 0.9,
      });
    }

    const customerName =
      state.focusSlot === 'customerName'
        ? this.detectName(text)
        : this.detectNamedName(text);
    if (customerName) {
      extractedUpdates.push({
        slotKey: 'customerName',
        value: customerName,
        confidence: 0.88,
      });
    }

    const shouldExtractDateTime = this.shouldExtractDateTime(text, state);

    const preferredDate = shouldExtractDateTime
      ? this.detectPreferredDate(text)
      : null;
    if (preferredDate) {
      extractedUpdates.push({
        slotKey: 'preferredDate',
        value: preferredDate,
        confidence: 0.9,
      });
    }

    const preferredTime = shouldExtractDateTime
      ? this.detectPreferredTime(text)
      : null;
    if (preferredTime) {
      extractedUpdates.push({
        slotKey: 'preferredTime',
        value: preferredTime,
        confidence: 0.88,
      });
    }

    return {
      userMove: extractedUpdates.length ? 'provide_info' : 'unknown',
      requestedSlotKey: null,
      extractedUpdates,
    };
  }

  private detectServiceType(lower: string): string | null {
    const serviceMatchers: Array<{ pattern: RegExp; value: string }> = [
      { pattern: /\boil change\b/i, value: 'oil change' },
      { pattern: /\blog ?book service\b/i, value: 'logbook service' },
      { pattern: /\bgeneral service\b/i, value: 'general service' },
      {
        pattern: /\btyre replacement\b|\btire replacement\b/i,
        value: 'tire replacement',
      },
      { pattern: /\btyre change\b|\btire change\b/i, value: 'tire change' },
      { pattern: /\bwheel alignment\b/i, value: 'wheel alignment' },
      { pattern: /\bbrake service\b/i, value: 'brake service' },
      { pattern: /\bbattery replacement\b/i, value: 'battery replacement' },
    ];

    for (const matcher of serviceMatchers) {
      if (matcher.pattern.test(lower)) {
        return matcher.value;
      }
    }

    return null;
  }

  private detectRegistration(text: string): string | null {
    const direct = this.extractPlateToken(text);
    if (direct) {
      return direct;
    }

    const spoken = this.extractMappedSequence(text, true);
    if (
      spoken.length >= 3 &&
      spoken.length <= 8 &&
      /[A-Z]/.test(spoken)
    ) {
      return spoken;
    }

    return null;
  }

  private detectPhoneNumber(lower: string): string | null {
    const digitsOnly = lower.replace(/\D/g, '');
    if (digitsOnly.length >= 8) {
      return digitsOnly;
    }

    const spokenDigits = lower
      .split(/[^a-z0-9]+/)
      .map((token) => numberWords.get(token) ?? '')
      .join('');
    return spokenDigits.length >= 8 ? spokenDigits : null;
  }

  private shouldExtractDateTime(
    text: string,
    state: BookingGraphStateValue,
  ): boolean {
    if (
      state.focusSlot === 'preferredDate' ||
      state.focusSlot === 'preferredTime' ||
      state.requestedSlotKey === 'preferredDate' ||
      state.requestedSlotKey === 'preferredTime'
    ) {
      return true;
    }

    const lower = this.normalizeDateTimeText(text);
    const monthPattern = Array.from(monthWords.keys()).join('|');
    const clockWords = Array.from(timeHourWords.keys()).join('|');

    return (
      /\b(today|tomorrow|day after tomorrow|next)\b/.test(lower) ||
      new RegExp(`\\b(${weekdayWords.join('|')}|${monthPattern})\\b`).test(
        lower,
      ) ||
      /\b\d{1,2}[:/\-.]\d{1,2}\b/.test(lower) ||
      new RegExp(
        `\\b(?:at|around|about|by|before|after)\\s+(?:\\d{1,2}|${clockWords}|midday|noon)\\b`,
      ).test(lower) ||
      new RegExp(
        `\\b(?:\\d{1,2}|${clockWords})\\s*(?:am|pm|a m|p m|o clock|oclock)\\b`,
      ).test(lower) ||
      /\b(?:for|in|during)\s+(?:the\s+)?(?:morning|afternoon|evening)\b/.test(
        lower,
      )
    );
  }

  private detectPreferredDate(text: string): string | null {
    const lower = this.normalizeDateTimeText(text);

    if (/\bday after tomorrow\b/.test(lower)) {
      return 'day after tomorrow';
    }
    if (/\btomorrow\b/.test(lower)) {
      return 'tomorrow';
    }
    if (/\btoday\b/.test(lower)) {
      return 'today';
    }

    const nextWeekday = lower.match(
      new RegExp(`\\bnext\\s+(${weekdayWords.join('|')})\\b`),
    );
    if (nextWeekday) {
      return `next ${nextWeekday[1]}`;
    }

    const numericDate = lower.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?[\/\-. ](\d{1,2})(?:[\/\-. ](\d{2,4}))?\b/,
    );
    if (numericDate) {
      const day = Number(numericDate[1]);
      const month = Number(numericDate[2]);
      const year = this.normalizeYearDigits(numericDate[3]);
      if (this.isValidDayMonth(day, month)) {
        return year ? `${day}/${month}/${year}` : `${day}/${month}`;
      }
    }

    const monthPattern = Array.from(monthWords.keys()).join('|');
    const numericDayMonth = lower.match(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})(?:\\s+(\\d{2,4}|twenty\\s+twenty\\s+\\w+))?\\b`,
      ),
    );
    if (numericDayMonth) {
      return this.formatSpokenDate(
        Number(numericDayMonth[1]),
        numericDayMonth[2],
        numericDayMonth[3],
      );
    }

    const spokenDayMonth = lower.match(
      new RegExp(
        `\\b((?:twenty|thirty)\\s+\\w+|\\w+)\\s+(?:of\\s+)?(${monthPattern})(?:\\s+(\\d{2,4}|twenty\\s+twenty\\s+\\w+))?\\b`,
      ),
    );
    if (spokenDayMonth) {
      const day = this.parseOrdinalDay(spokenDayMonth[1]);
      if (day) {
        return this.formatSpokenDate(
          day,
          spokenDayMonth[2],
          spokenDayMonth[3],
        );
      }
    }

    const weekday = lower.match(
      new RegExp(`\\b(${weekdayWords.join('|')})\\b`),
    );
    return weekday?.[1] ?? null;
  }

  private detectPreferredTime(text: string): string | null {
    const lower = this.normalizeDateTimeText(text);

    const numericTime = lower.match(
      /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m|a\.m\.|p\.m\.)\b/i,
    );
    if (numericTime) {
      const suffix = numericTime[3].replace(/[\s.]/g, '').toLowerCase();
      return numericTime[2]
        ? `${numericTime[1]}:${numericTime[2]} ${suffix}`
        : `${numericTime[1]} ${suffix}`;
    }

    const spokenTime = lower.match(
      /\b(?:at\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(?:o clock|oclock))?(?:\s*(am|pm|a m|p m|a\.m\.|p\.m\.))?\b/i,
    );
    if (spokenTime && (spokenTime[2] || /\b(at|o clock|oclock)\b/.test(lower))) {
      const hour = timeHourWords.get(spokenTime[1]);
      if (hour) {
        const suffix = spokenTime[2]?.replace(/[\s.]/g, '').toLowerCase();
        return suffix ? `${hour} ${suffix}` : `${hour} o'clock`;
      }
    }

    const broadTime = lower.match(
      /\b(morning|afternoon|evening|midday|noon)\b/,
    );
    return broadTime?.[1] ?? null;
  }

  private normalizeDateTimeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/\ba\.m\./g, 'am')
      .replace(/\bp\.m\./g, 'pm')
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9:/.\-\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeYearDigits(rawYear?: string): string | null {
    if (!rawYear) {
      return null;
    }

    if (/^\d{2}$/.test(rawYear)) {
      return `20${rawYear}`;
    }

    if (/^\d{4}$/.test(rawYear)) {
      return rawYear;
    }

    return this.parseSpokenYear(rawYear)?.toString() ?? null;
  }

  private parseSpokenYear(rawYear: string): number | null {
    const tokens = rawYear.trim().toLowerCase().split(/\s+/);
    if (
      tokens.length === 3 &&
      tokens[0] === 'twenty' &&
      tokens[1] === 'twenty'
    ) {
      const lastDigit = numberWords.get(tokens[2]);
      return lastDigit ? 2020 + Number(lastDigit) : null;
    }

    return null;
  }

  private isValidDayMonth(day: number, month: number): boolean {
    return (
      Number.isInteger(day) &&
      Number.isInteger(month) &&
      day >= 1 &&
      day <= 31 &&
      month >= 1 &&
      month <= 12
    );
  }

  private formatSpokenDate(
    day: number,
    rawMonth: string,
    rawYear?: string,
  ): string | null {
    const month = monthWords.get(rawMonth.toLowerCase());
    if (!month || day < 1 || day > 31) {
      return null;
    }

    const year = this.normalizeYearDigits(rawYear);
    return year ? `${day} ${month} ${year}` : `${day} ${month}`;
  }

  private parseOrdinalDay(rawDay: string): number | null {
    const normalized = rawDay.trim().toLowerCase().replace(/\s+/g, ' ');
    const direct = ordinalWords.get(normalized);
    if (direct) {
      return direct;
    }

    const parts = normalized.split(' ');
    if (parts.length === 2) {
      const tens = tensWords.get(parts[0]);
      const ordinal = ordinalWords.get(parts[1]);
      if (tens && ordinal && ordinal < 10) {
        return tens + ordinal;
      }
    }

    return null;
  }

  private detectNamedName(text: string): string | null {
    const match = text.match(
      /\bmy name is ([a-z][a-z'\-]+(?: [a-z][a-z'\-]+){0,3})/i,
    );
    return match?.[1]?.trim() ?? null;
  }

  private detectName(text: string): string | null {
    const cleaned = text
      .replace(/[^\p{L}' -]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      return null;
    }

    const words = cleaned.split(' ');
    if (
      words.length <= 4 &&
      words.every((word) => /^[\p{L}'-]+$/u.test(word))
    ) {
      return cleaned;
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

  private extractPlateToken(text: string): string | null {
    const matches = text.toUpperCase().match(/\b[A-Z0-9]{3,8}\b/g) ?? [];
    const banned = new Set([
      'EMAIL',
      'PHONE',
      'NUMBER',
      'SERVICE',
      'REGO',
      'PLATE',
      'CAR',
      'BOOKING',
      'REGISTRATION',
    ]);

    return (
      matches.find((candidate) => {
        const normalized = candidate.toLowerCase();
        if (banned.has(candidate)) {
          return false;
        }
        if (this.isCommonWord(normalized)) {
          return false;
        }
        if (numberWords.has(normalized) || spokenLetterWords.has(normalized)) {
          return false;
        }
        return true;
      }) ?? null
    );
  }

  private extractMappedSequence(
    text: string,
    allowLooseNumberAliases: boolean,
  ): string {
    const outputs: string[] = [];

    for (const rawToken of text.split(/\s+/)) {
      const token = rawToken.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!token) {
        continue;
      }

      const letter = spokenLetterWords.get(token);
      if (letter) {
        outputs.push(letter);
        continue;
      }

      if (/^\d+$/.test(token)) {
        outputs.push(token);
        continue;
      }

      const digit = this.mapNumberToken(token, allowLooseNumberAliases);
      if (digit) {
        outputs.push(digit);
        continue;
      }

      if (/^[a-z0-9]{2,8}$/i.test(token) && !this.isCommonWord(token)) {
        outputs.push(token.toUpperCase());
      }
    }

    return outputs.join('');
  }

  private mapNumberToken(
    token: string,
    allowLooseAliases: boolean,
  ): string | null {
    const mapped = numberWords.get(token);
    if (!mapped) {
      return null;
    }

    if (!allowLooseAliases && looseNumberAliases.has(token)) {
      return null;
    }

    return mapped;
  }

  private mergeRegistrationContinuation(
    current: BookingGraphSlotState,
    candidate: { value: string; canonicalValue: string | null },
    utterance: string,
  ): { value: string; canonicalValue: string | null } {
    const currentValue = (current.canonicalValue ?? current.value ?? '').toUpperCase();
    const candidateValue = (
      candidate.canonicalValue ??
      candidate.value ??
      ''
    ).toUpperCase();

    if (
      !currentValue ||
      !candidateValue ||
      !current.needsConfirmation ||
      current.status === 'confirmed' ||
      currentValue === candidateValue
    ) {
      return candidate;
    }

    if (
      currentValue.includes(candidateValue) ||
      candidateValue.includes(currentValue)
    ) {
      const merged =
        candidateValue.length >= currentValue.length
          ? candidateValue
          : currentValue;
      return { value: merged, canonicalValue: merged };
    }

    const shortContinuation =
      utterance
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean).length <= 4;
    if (!shortContinuation) {
      return candidate;
    }

    const overlapped = this.combineRegistrationParts(
      currentValue,
      candidateValue,
    );
    if (overlapped) {
      return { value: overlapped, canonicalValue: overlapped };
    }

    const appended = `${currentValue}${candidateValue}`;
    if (/^[A-Z0-9]{4,8}$/.test(appended)) {
      return { value: appended, canonicalValue: appended };
    }

    return candidate;
  }

  private combineRegistrationParts(left: string, right: string): string | null {
    const maxOverlap = Math.min(left.length, right.length);

    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      if (!left.endsWith(right.slice(0, overlap))) {
        continue;
      }

      const combined = `${left}${right.slice(overlap)}`;
      if (/^[A-Z0-9]{4,8}$/.test(combined)) {
        return combined;
      }
    }

    return null;
  }

  private isCommonWord(token: string): boolean {
    return [
      'a',
      'an',
      'is',
      'it',
      'its',
      'me',
      'i',
      'the',
      'and',
      'for',
      'with',
      'again',
      'back',
      'book',
      'booking',
      'call',
      'can',
      'service',
      'share',
      'provide',
      'change',
      'my',
      'name',
      'best',
      'full',
      'spell',
      'spelling',
      'vehicle',
      'phone',
      'email',
      'registration',
      'rego',
      'plate',
      'next',
      'please',
      'need',
      'would',
      'like',
      'this',
      'that',
      'yes',
      'yeah',
      'yep',
      'no',
      'nope',
      'ok',
      'okay',
      'continue',
      'we',
      'not',
      'notcorrect',
      'notright',
      'correct',
      'wrong',
      'thatscorrect',
      'thatiscorrect',
      'thatswrong',
      'thatiswrong',
      'thatsnotcorrect',
      'thatisnotcorrect',
      'itscorrect',
      'itiscorrect',
      'itswrong',
      'itiswrong',
      'right',
      'after',
      'before',
      'read',
      'confirm',
      'text',
      'entirely',
      'end',
      'car',
      'cars',
      'oil',
    ].includes(token);
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

  private toIntentSlotStatus(
    status: BookingGraphSlotState['status'],
  ): IntentSlotStatus {
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
