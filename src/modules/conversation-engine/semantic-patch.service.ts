import { Injectable } from '@nestjs/common';
import {
  SemanticPatch,
  TranscriptFragment,
} from '../../common/types/conversation.types';
import { SessionState } from '../../common/types/session.types';
import { nowIso } from '../../common/utils/timing';
import { ConversationProfile } from './conversation-profile.registry';

const serviceTypeKeywords: Record<string, string[]> = {
  oil_change: ['oil change', 'oil service'],
  logbook_service: ['logbook service', 'log book service', 'scheduled service'],
  inspection: ['inspection', 'check-up', 'check up', 'diagnostic'],
  brakes: ['brakes', 'brake service', 'brake pads'],
  battery: ['battery', 'battery check', 'battery replacement'],
  tires: ['tyres', 'tires', 'wheel alignment', 'tyre rotation', 'tire rotation'],
  repair: ['repair', 'fix', 'not working', 'issue', 'problem'],
};

type CaptureSlotKey =
  | 'vehicleRegistration'
  | 'phoneNumber'
  | 'customerEmail'
  | 'customerName'
  | null;

const numberWords = new Map<string, string>([
  ['zero', '0'],
  ['oh', '0'],
  ['o', '0'],
  ['won', '1'],
  ['one', '1'],
  ['to', '2'],
  ['too', '2'],
  ['two', '2'],
  ['three', '3'],
  ['for', '4'],
  ['fore', '4'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['ate', '8'],
  ['eight', '8'],
  ['nine', '9'],
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
  ['o', 'O'],
  ['p', 'P'],
  ['pee', 'P'],
  ['q', 'Q'],
  ['cue', 'Q'],
  ['queue', 'Q'],
  ['r', 'R'],
  ['are', 'R'],
  ['ar', 'R'],
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
  ['doubleyou', 'W'],
  ['doubleu', 'W'],
  ['x', 'X'],
  ['ex', 'X'],
  ['y', 'Y'],
  ['why', 'Y'],
  ['wye', 'Y'],
  ['z', 'Z'],
  ['zee', 'Z'],
  ['zed', 'Z'],
]);

const emailSymbolWords = new Map<string, string>([
  ['at', '@'],
  ['dot', '.'],
  ['period', '.'],
  ['point', '.'],
  ['underscore', '_'],
  ['under score', '_'],
  ['dash', '-'],
  ['hyphen', '-'],
  ['minus', '-'],
  ['plus', '+'],
]);

interface CaptureUnit {
  output: string;
  spoken: string;
}

interface ExtractedSlotValue {
  slotKey: string;
  value: string;
  canonicalValue?: string | null;
  confidence: number;
  needsConfirmation?: boolean;
}

interface NormalizedCaptureToken {
  output: string;
  confidence: number;
  merged: boolean;
}

interface RegistrationCapture {
  candidate: string;
  confidence: number;
  hasMergedTokens: boolean;
}

const letterCaptureUnits: CaptureUnit[] = [
  ['A', 'ay'],
  ['B', 'bee'],
  ['C', 'see'],
  ['D', 'dee'],
  ['E', 'ee'],
  ['F', 'ef'],
  ['G', 'gee'],
  ['H', 'aitch'],
  ['I', 'eye'],
  ['J', 'jay'],
  ['K', 'kay'],
  ['L', 'el'],
  ['M', 'em'],
  ['N', 'en'],
  ['O', 'oh'],
  ['P', 'pee'],
  ['Q', 'cue'],
  ['R', 'ar'],
  ['S', 'ess'],
  ['T', 'tee'],
  ['U', 'you'],
  ['V', 'vee'],
  ['W', 'doubleu'],
  ['X', 'ex'],
  ['Y', 'why'],
  ['Z', 'zed'],
].map(([output, spoken]) => ({ output, spoken }));

const digitCaptureUnits: CaptureUnit[] = [
  ['0', 'zero'],
  ['1', 'one'],
  ['2', 'two'],
  ['3', 'three'],
  ['4', 'four'],
  ['5', 'five'],
  ['6', 'six'],
  ['7', 'seven'],
  ['8', 'eight'],
  ['9', 'nine'],
].map(([output, spoken]) => ({ output, spoken }));

const emailCaptureUnits: CaptureUnit[] = [
  ...letterCaptureUnits.map((unit) => ({
    output: unit.output.toLowerCase(),
    spoken: unit.spoken,
  })),
  ...digitCaptureUnits,
  { output: '@', spoken: 'at' },
  { output: '.', spoken: 'dot' },
  { output: '_', spoken: 'underscore' },
  { output: '-', spoken: 'dash' },
  { output: '+', spoken: 'plus' },
];

const registrationMergedUnits = buildMergedUnits(
  [...letterCaptureUnits, ...digitCaptureUnits],
  (left, right) =>
    /\d/.test(left.output) || /\d/.test(right.output),
);

const nameMergedUnits = buildMergedUnits(letterCaptureUnits, () => true);

function buildMergedUnits(
  units: CaptureUnit[],
  include: (left: CaptureUnit, right: CaptureUnit) => boolean,
): CaptureUnit[] {
  const merged: CaptureUnit[] = [];
  for (const left of units) {
    for (const right of units) {
      if (!include(left, right)) {
        continue;
      }
      merged.push({
        output: `${left.output}${right.output}`,
        spoken: `${left.spoken}${right.spoken}`,
      });
    }
  }
  return merged;
}

@Injectable()
export class SemanticPatchService {
  buildPatches(
    session: SessionState,
    profile: ConversationProfile,
    fragment: TranscriptFragment,
  ): SemanticPatch[] {
    const now = nowIso();
    const existingThought = session.conversation?.liveIntent.pendingThought.text ?? '';
    const combinedThought = [existingThought, fragment.normalizedText]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const captureTarget = this.resolveCaptureTarget(session, profile, combinedThought);
    const incompleteReason = this.detectIncompleteThought(
      profile,
      combinedThought,
      captureTarget,
    );

    const patches: SemanticPatch[] = [
      {
        type: 'append_thought_fragment',
        fragmentId: fragment.id,
        text: fragment.normalizedText,
        at: fragment.receivedAt,
      },
      {
        type: 'set_floor',
        state: 'user_thinking',
        stability: incompleteReason ? 0.28 : 0.62,
        at: fragment.receivedAt,
      },
      {
        type: 'mark_pending_thought',
        status: incompleteReason ? 'forming' : 'ready',
        incompleteReason,
        holdUntil: null,
      },
    ];

    patches.push(
      ...this.extractControlPatches(
        session,
        profile,
        combinedThought,
        fragment,
      ),
    );

    if (profile.key === 'generic') {
      return patches;
    }

    if (this.hasSubstantiveContent(combinedThought)) {
      patches.push({
        type: 'set_intent',
        intentName: profile.intentName,
        confidence: 0.86,
        status: incompleteReason ? 'forming' : 'usable',
        fragmentId: fragment.id,
        at: now,
      });
    }

    if (this.isSlotControlUtterance(combinedThought)) {
      return patches;
    }

    const slotUpdates = this.extractCarBookingSlots(combinedThought, captureTarget);
    for (const slotUpdate of slotUpdates) {
      patches.push({
        type: 'upsert_slot',
        slotKey: slotUpdate.slotKey,
        value: slotUpdate.value,
        canonicalValue: slotUpdate.canonicalValue,
        confidence: slotUpdate.confidence,
        status: 'provisional',
        needsConfirmation: slotUpdate.needsConfirmation,
        fragmentId: fragment.id,
        at: now,
      });
    }

    return patches;
  }

  private hasSubstantiveContent(text: string): boolean {
    const lower = text.trim().toLowerCase();
    if (!lower) {
      return false;
    }

    return !/^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait)$/i.test(
      lower,
    );
  }

  private detectIncompleteThought(
    profile: ConversationProfile,
    text: string,
    captureTarget: CaptureSlotKey,
  ): string | null {
    const lower = text.trim().toLowerCase();
    if (!lower) {
      return 'empty';
    }

    if (
      /^(uh|um|hmm|erm|let me think|one sec|one second|hold on|wait|sorry)$/i.test(
        lower,
      )
    ) {
      return 'filler_only';
    }

    if (
      /\b(in|on|for|with|about|to|from|at|my|the|a|an|and|or|but|because|if|when|tomorrow|today)$/.test(
        lower,
      )
    ) {
      return 'open_ended_phrase';
    }

    if (
      /\b(my name is|this is|i am|i'm|rego is|registration is|phone is|number is)\s*$/i.test(
        lower,
      )
    ) {
      return 'slot_value_incomplete';
    }

    const digits = this.extractDigitString(lower);
    if (
      /\b(phone|mobile|number)\b/.test(lower) &&
      digits.length > 0 &&
      digits.length < 10
    ) {
      return 'phone_incomplete';
    }

    if (
      /\b(rego|registration|plate)\b/.test(lower) &&
      !this.extractRegistration(lower, 'vehicleRegistration')
    ) {
      return 'registration_incomplete';
    }

    if (captureTarget === 'vehicleRegistration') {
      const candidate = this.extractSpokenRegistrationCapture(text).candidate;
      if (candidate && candidate.length < 4) {
        return 'registration_capture_incomplete';
      }
      if (!candidate && this.looksLikeSpelledRegistration(text)) {
        return 'registration_capture_incomplete';
      }
    }

    if (captureTarget === 'phoneNumber') {
      const digits = this.extractDigitString(text.toLowerCase(), true);
      if (digits.length > 0 && digits.length < 8) {
        return 'phone_capture_incomplete';
      }
    }

    if (captureTarget === 'customerEmail') {
      const emailCandidate = this.extractSpokenEmailCandidate(text);
      if (emailCandidate && !this.isEmailAddress(emailCandidate)) {
        return 'email_capture_incomplete';
      }
      if (
        !emailCandidate &&
        /\b(email|at|dot|underscore|dash|hyphen)\b/i.test(text)
      ) {
        return 'email_capture_incomplete';
      }
    }

    if (
      captureTarget === 'customerName' &&
      this.looksLikeSpelledName(text) &&
      this.extractSpelledNameCapture(text).value.length < 2
    ) {
      return 'name_capture_incomplete';
    }

    const wordCount = lower.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 3) {
      return 'short_thought_likely_continuing';
    }

    if (
      profile.key === 'car_booking_receptionist' &&
      /\b(book|booking|service|repair|inspection|oil change)\b/.test(lower) &&
      wordCount <= 6 &&
      !/[.!?]$/.test(lower)
    ) {
      return 'service_request_still_forming';
    }

    return null;
  }

  private extractCarBookingSlots(
    text: string,
    captureTarget: CaptureSlotKey,
  ): ExtractedSlotValue[] {
    const updates: ExtractedSlotValue[] = [];

    const serviceType = this.extractServiceType(text);
    if (serviceType) {
      updates.push({
        slotKey: 'serviceType',
        value: serviceType.label,
        canonicalValue: serviceType.key,
        confidence: 0.92,
      });
    }

    const registration = this.extractRegistration(text, captureTarget);
    if (registration) {
      updates.push({
        slotKey: 'vehicleRegistration',
        value: registration.value,
        canonicalValue: registration.value,
        confidence: registration.confidence,
        needsConfirmation: registration.needsConfirmation,
      });
    }

    const name = this.extractCustomerName(text, captureTarget);
    if (name) {
      updates.push({
        slotKey: 'customerName',
        value: name.value,
        canonicalValue: name.value,
        confidence: name.confidence,
        needsConfirmation: name.needsConfirmation,
      });
    }

    const phoneNumber = this.extractPhoneNumber(text, captureTarget);
    if (phoneNumber) {
      updates.push({
        slotKey: 'phoneNumber',
        value: phoneNumber.display,
        canonicalValue: phoneNumber.canonical,
        confidence: phoneNumber.confidence,
        needsConfirmation: phoneNumber.needsConfirmation,
      });
    }

    const customerEmail = this.extractCustomerEmail(text, captureTarget);
    if (customerEmail) {
      updates.push({
        slotKey: 'customerEmail',
        value: customerEmail.value,
        canonicalValue: customerEmail.value,
        confidence: customerEmail.confidence,
        needsConfirmation: customerEmail.needsConfirmation,
      });
    }

    const preferredDate = this.extractPreferredDate(text);
    if (preferredDate) {
      updates.push({
        slotKey: 'preferredDate',
        value: preferredDate,
        canonicalValue: preferredDate,
        confidence: 0.76,
      });
    }

    const preferredTime = this.extractPreferredTime(text);
    if (preferredTime) {
      updates.push({
        slotKey: 'preferredTime',
        value: preferredTime,
        canonicalValue: preferredTime,
        confidence: 0.74,
      });
    }

    const issueDescription = this.extractIssueDescription(text);
    if (issueDescription) {
      updates.push({
        slotKey: 'issueDescription',
        value: issueDescription,
        canonicalValue: issueDescription,
        confidence: 0.66,
      });
    }

    return updates;
  }

  private extractServiceType(
    text: string,
  ): { key: string; label: string } | null {
    const lower = text.toLowerCase();
    for (const [key, keywords] of Object.entries(serviceTypeKeywords)) {
      if (keywords.some((keyword) => lower.includes(keyword))) {
        return {
          key,
          label: key.replaceAll('_', ' '),
        };
      }
    }

    if (/\bservice\b/.test(lower)) {
      return {
        key: 'service',
        label: 'service',
      };
    }

    return null;
  }

  private extractCustomerName(
    text: string,
    captureTarget: CaptureSlotKey,
  ): {
    value: string;
    confidence: number;
    needsConfirmation: boolean;
  } | null {
    const match = text.match(
      /\b(?:my name is|this is|i am|i'm)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i,
    );
    const explicitName = match?.[1]
      ?.trim()
      .split(/\s+/)
      .map((part) =>
        part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}` : '',
      )
      .join(' ')
      .trim();

    if (explicitName) {
      return {
        value: explicitName,
        confidence: 0.97,
        needsConfirmation: false,
      };
    }

    if (captureTarget !== 'customerName') {
      return null;
    }

    const stripped = this.stripSlotLeadIn(text, [
      /\b(?:my name is|this is|i am|i'm|name is|customer name is)\b/gi,
      /\b(?:it'?s|that is|thats)\b/gi,
      /\b(?:spelled|spell that|spell it)\b/gi,
    ]);
    const spelled = this.extractSpelledNameCapture(stripped);
    if (spelled.value.length >= 2) {
      return spelled;
    }

    if (this.looksLikePlainName(stripped)) {
      return {
        value: this.toTitleCase(stripped),
        confidence: 0.84,
        needsConfirmation: false,
      };
    }

    return null;
  }

  private extractPhoneNumber(
    text: string,
    captureTarget: CaptureSlotKey,
  ): {
    canonical: string;
    display: string;
    confidence: number;
    needsConfirmation: boolean;
  } | null {
    const lower = text.toLowerCase();
    const explicit =
      /\b(phone|mobile|number|call me on|reach me on|best number)\b/.test(lower);
    if (!explicit && captureTarget !== 'phoneNumber') {
      return null;
    }

    const digits = this.extractDigitString(
      this.stripSlotLeadIn(text, [
        /\b(?:my|the)?\s*(?:phone|mobile|number)\s+(?:is|number is)\b/gi,
        /\b(?:call me on|reach me on|best number is)\b/gi,
      ]).toLowerCase(),
      true,
    );
    if (digits.length < 8) {
      return null;
    }

    const canonical = digits.slice(0, 12);
    return {
      canonical,
      display: canonical.replace(/(\d{4})(?=\d)/g, '$1 ').trim(),
      confidence:
        canonical.length >= 10
          ? captureTarget === 'phoneNumber'
            ? 0.97
            : 0.94
          : 0.68,
      needsConfirmation: canonical.length < 10,
    };
  }

  private extractRegistration(
    text: string,
    captureTarget: CaptureSlotKey,
  ): {
    value: string;
    confidence: number;
    needsConfirmation: boolean;
  } | null {
    const explicit = /\b(rego|registration|plate)\b/i.test(text);
    const cleaned = text
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ');
    const matches = cleaned.match(/\b[A-Z0-9]{5,8}\b/g) ?? [];

    for (const candidate of matches) {
      if (/^\d+$/.test(candidate)) {
        continue;
      }
      if (!/[A-Z]/.test(candidate) || !/\d/.test(candidate)) {
        continue;
      }
      return {
        value: candidate,
        confidence: 0.98,
        needsConfirmation: false,
      };
    }

    if (!explicit && captureTarget !== 'vehicleRegistration') {
      return null;
    }

    const capture = this.extractSpokenRegistrationCapture(text);
    if (
      capture.candidate.length >= 4 &&
      capture.candidate.length <= 8 &&
      /[A-Z]/.test(capture.candidate) &&
      /\d/.test(capture.candidate)
    ) {
      return {
        value: capture.candidate,
        confidence: capture.confidence,
        needsConfirmation: capture.hasMergedTokens || capture.confidence < 0.9,
      };
    }

    return null;
  }

  private extractPreferredDate(text: string): string | null {
    const match = text.match(
      /\b(today|tomorrow|next week|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    );
    return match?.[1]?.trim() ?? null;
  }

  private extractPreferredTime(text: string): string | null {
    const match =
      text.match(/\b(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i) ??
      text.match(/\b(morning|afternoon|evening)\b/i);
    return match?.[1]?.trim() ?? null;
  }

  private extractIssueDescription(text: string): string | null {
    const lower = text.toLowerCase();
    if (
      /\b(problem|issue|noise|warning light|check engine|not working|rattle|vibration|leak)\b/.test(
        lower,
      )
    ) {
      return text.replace(/\s+/g, ' ').trim();
    }

    return null;
  }

  private extractCustomerEmail(
    text: string,
    captureTarget: CaptureSlotKey,
  ): {
    value: string;
    confidence: number;
    needsConfirmation: boolean;
  } | null {
    const lower = text.toLowerCase();
    const explicit = /\b(email|e-mail|email address)\b/.test(lower);
    if (!explicit && captureTarget !== 'customerEmail') {
      return null;
    }

    const stripped = this.stripSlotLeadIn(text, [
      /\b(?:my|the)?\s*(?:email|e-mail|email address)\s+(?:is|address is)\b/gi,
      /\b(?:contact email is|send it to)\b/gi,
    ]);
    const candidate = this.extractSpokenEmailCandidate(stripped);
    if (!this.isEmailAddress(candidate)) {
      return null;
    }

    return {
      value: candidate,
      confidence: explicit ? 0.92 : 0.88,
      needsConfirmation: !explicit,
    };
  }

  private extractDigitString(text: string, _aggressive = false): string {
    const normalizedWords = text
      .replace(/\bdouble\s+([a-z]+)\b/g, (_match, value: string) => {
        const digit = numberWords.get(value) ?? '';
        return digit ? `${digit}${digit}` : value;
      })
      .replace(/\btriple\s+([a-z]+)\b/g, (_match, value: string) => {
        const digit = numberWords.get(value) ?? '';
        return digit ? `${digit}${digit}${digit}` : value;
      })
      .split(/\s+/)
      .map((word) => numberWords.get(word) ?? word)
      .join(' ');

    return normalizedWords.replace(/\D/g, '');
  }

  private resolveCaptureTarget(
    session: SessionState,
    profile: ConversationProfile,
    text: string,
  ): CaptureSlotKey {
    const lower = text.toLowerCase();
    if (/\b(email|e-mail|email address)\b/.test(lower)) {
      return 'customerEmail';
    }
    if (/\b(phone|mobile|number|call me on|reach me on)\b/.test(lower)) {
      return 'phoneNumber';
    }
    if (/\b(rego|registration|plate)\b/.test(lower)) {
      return 'vehicleRegistration';
    }
    if (/\b(my name is|this is|i am|i'm|name is)\b/.test(lower)) {
      return 'customerName';
    }

    const promptedSlot = session.conversation?.liveIntent.prompt.slotKey;
    if (
      promptedSlot === 'vehicleRegistration' ||
      promptedSlot === 'phoneNumber' ||
      promptedSlot === 'customerEmail' ||
      promptedSlot === 'customerName'
    ) {
      return promptedSlot;
    }

    const nextMissingActionSlot = profile.actionReadySlotKeys.find((slotKey) => {
      const slot = session.conversation?.liveIntent.slots[slotKey];
      return !slot?.value || slot.needsConfirmation || slot.status !== 'confirmed';
    });

    if (
      nextMissingActionSlot === 'vehicleRegistration' ||
      nextMissingActionSlot === 'phoneNumber' ||
      nextMissingActionSlot === 'customerName'
    ) {
      return nextMissingActionSlot;
    }

    return null;
  }

  private extractControlPatches(
    session: SessionState,
    profile: ConversationProfile,
    text: string,
    fragment: TranscriptFragment,
  ): SemanticPatch[] {
    if (profile.key !== 'car_booking_receptionist') {
      return [];
    }

    const patches: SemanticPatch[] = [];
    const prompt = session.conversation?.liveIntent.prompt;
    const lower = text.trim().toLowerCase();

    if (prompt?.action === 'confirm' && prompt.slotKey) {
      if (this.isAffirmative(lower)) {
        patches.push({
          type: 'confirm_slot',
          slotKey: prompt.slotKey,
          at: fragment.receivedAt,
        });
      } else if (this.isNegative(lower)) {
        patches.push({
          type: 'clear_slot',
          slotKey: prompt.slotKey,
          at: fragment.receivedAt,
        });
      }
    }

    const correctedSlot = this.detectCorrectedSlot(session, text);
    if (correctedSlot) {
      patches.push({
        type: 'clear_slot',
        slotKey: correctedSlot,
        at: fragment.receivedAt,
      });
    }

    return patches;
  }

  private detectCorrectedSlot(
    session: SessionState,
    text: string,
  ): CaptureSlotKey {
    const lower = text.toLowerCase();

    if (
      /\b(?:not (?:the )?correct|wrong|incorrect|not right)\b.*\b(rego|registration|plate)\b/.test(
        lower,
      )
    ) {
      return 'vehicleRegistration';
    }
    if (
      /\b(?:not (?:the )?correct|wrong|incorrect|not right)\b.*\b(phone|mobile|number)\b/.test(
        lower,
      )
    ) {
      return 'phoneNumber';
    }
    if (
      /\b(?:not (?:the )?correct|wrong|incorrect|not right)\b.*\b(email|e-mail)\b/.test(
        lower,
      )
    ) {
      return 'customerEmail';
    }
    if (
      /\b(?:not (?:the )?correct|wrong|incorrect|not right)\b.*\b(name)\b/.test(
        lower,
      )
    ) {
      return 'customerName';
    }

    if (this.isNegative(lower)) {
      const promptSlot = session.conversation?.liveIntent.prompt.slotKey;
      if (
        promptSlot === 'vehicleRegistration' ||
        promptSlot === 'phoneNumber' ||
        promptSlot === 'customerEmail' ||
        promptSlot === 'customerName'
      ) {
        return promptSlot;
      }
    }

    return null;
  }

  private isAffirmative(text: string): boolean {
    return /^(?:yes|yeah|yep|correct|that'?s right|that is right|right|exactly|affirmative|sure)$/i.test(
      text.trim(),
    );
  }

  private isNegative(text: string): boolean {
    return /^(?:no|nope|nah|not correct|that'?s not correct|that is not correct|wrong|incorrect|not right)$/i.test(
      text.trim(),
    );
  }

  private isSlotControlUtterance(text: string): boolean {
    const lower = text.toLowerCase().trim();
    if (
      /\b(confirm|check|repeat)\b.*\b(rego|registration|plate|phone|mobile|number|email|e-mail|name)\b/.test(
        lower,
      )
    ) {
      return true;
    }

    return (
      /\b(?:not (?:the )?correct|wrong|incorrect|not right)\b.*\b(rego|registration|plate|phone|mobile|number|email|e-mail|name)\b/.test(
        lower,
      ) || this.isAffirmative(lower) || this.isNegative(lower)
    );
  }

  private extractSpokenRegistrationCapture(text: string): RegistrationCapture {
    const stripped = this.stripSlotLeadIn(text, [
      /\b(?:the\s+)?(?:vehicle\s+)?(?:registration|rego|plate)(?:\s+(?:is|number is))?\b/gi,
      /\b(?:it'?s|that is|thats)\b/gi,
    ]);
    const tokens = this.tokenizeCaptureInput(stripped);
    const normalized = tokens
      .map((token) => this.normalizeRegistrationToken(token))
      .filter((token) => Boolean(token.output));
    const candidate = normalized
      .map((token) => token.output)
      .join('')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    const confidence = normalized.length
      ? normalized.reduce((sum, token) => sum + token.confidence, 0) /
        normalized.length
      : 0;

    return {
      candidate,
      confidence,
      hasMergedTokens: normalized.some((token) => token.merged),
    };
  }

  private looksLikeSpelledRegistration(text: string): boolean {
    const stripped = this.stripSlotLeadIn(text, [
      /\b(?:the\s+)?(?:vehicle\s+)?(?:registration|rego|plate)(?:\s+(?:is|number is))?\b/gi,
    ]);
    const tokens = this.tokenizeCaptureInput(stripped);
    return tokens.some(
      (token) =>
        Boolean(this.normalizeRegistrationToken(token).output) ||
        /^[A-Za-z0-9-]+$/.test(token),
    );
  }

  private extractSpokenEmailCandidate(text: string): string {
    const tokens = this.tokenizeCaptureInput(text);
    const normalized = tokens
      .map((token) => this.normalizeCaptureToken(token, 'customerEmail'))
      .filter(Boolean)
      .join('')
      .replace(/\s+/g, '')
      .toLowerCase();

    return normalized;
  }

  private extractSpelledNameCapture(text: string): {
    value: string;
    confidence: number;
    needsConfirmation: boolean;
  } {
    const tokens = this.tokenizeCaptureInput(text);
    const normalized = tokens
      .map((token) => this.normalizeNameToken(token))
      .filter((token) => Boolean(token.output));
    const characters = normalized.map((token) => token.output).join('');

    if (!characters) {
      return {
        value: '',
        confidence: 0,
        needsConfirmation: false,
      };
    }

    const confidence = normalized.length
      ? normalized.reduce((sum, token) => sum + token.confidence, 0) /
        normalized.length
      : 0;

    return {
      value: this.toTitleCase(characters),
      confidence,
      needsConfirmation: normalized.some((token) => token.merged),
    };
  }

  private looksLikeSpelledName(text: string): boolean {
    const stripped = this.stripSlotLeadIn(text, [
      /\b(?:my name is|this is|i am|i'm|name is)\b/gi,
      /\b(?:spelled|spell that|spell it)\b/gi,
    ]);
    const tokens = this.tokenizeCaptureInput(stripped);
    return (
      tokens.length > 0 &&
      tokens.every((token) => Boolean(this.normalizeNameToken(token).output))
    );
  }

  private looksLikePlainName(text: string): boolean {
    const cleaned = text
      .replace(/[^A-Za-z\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      return false;
    }

    if (
      /\b(oil|service|booking|rego|registration|phone|number|email|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        cleaned,
      )
    ) {
      return false;
    }

    return /^[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2}$/.test(cleaned);
  }

  private tokenizeCaptureInput(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[@]/g, ' @ ')
      .replace(/[.,!?/\\]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/_/g, ' _ ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  }

  private normalizeRegistrationToken(token: string): NormalizedCaptureToken {
    if (!token) {
      return { output: '', confidence: 0, merged: false };
    }

    if (spokenLetterWords.has(token)) {
      return {
        output: spokenLetterWords.get(token) ?? '',
        confidence: 0.98,
        merged: false,
      };
    }

    if (numberWords.has(token)) {
      return {
        output: numberWords.get(token) ?? '',
        confidence: 0.96,
        merged: false,
      };
    }

    if (/^[a-z0-9]$/i.test(token)) {
      return {
        output: token.toUpperCase(),
        confidence: 0.96,
        merged: false,
      };
    }

    const fuzzyRegistration = this.fuzzyNormalizeToken(token, 'vehicleRegistration');
    if (fuzzyRegistration) {
      return {
        output: fuzzyRegistration.toUpperCase(),
        confidence: fuzzyRegistration.length > 1 ? 0.78 : 0.84,
        merged: fuzzyRegistration.length > 1,
      };
    }

    if (/^[a-z0-9]{2,3}$/i.test(token)) {
      return {
        output: token.toUpperCase(),
        confidence: token.length === 3 ? 0.82 : 0.76,
        merged: true,
      };
    }

    return { output: '', confidence: 0, merged: false };
  }

  private normalizeNameToken(token: string): NormalizedCaptureToken {
    if (!token) {
      return { output: '', confidence: 0, merged: false };
    }

    if (spokenLetterWords.has(token)) {
      return {
        output: (spokenLetterWords.get(token) ?? '').toLowerCase(),
        confidence: 0.97,
        merged: false,
      };
    }

    if (/^[a-z]$/i.test(token)) {
      return {
        output: token.toLowerCase(),
        confidence: 0.96,
        merged: false,
      };
    }

    const fuzzyName = this.fuzzyNormalizeToken(token, 'customerName');
    if (fuzzyName) {
      return {
        output: fuzzyName.toLowerCase(),
        confidence: fuzzyName.length > 1 ? 0.76 : 0.84,
        merged: fuzzyName.length > 1,
      };
    }

    return { output: '', confidence: 0, merged: false };
  }

  private normalizeCaptureToken(
    token: string,
    captureTarget: Exclude<CaptureSlotKey, null>,
  ): string {
    if (!token) {
      return '';
    }

    if (captureTarget === 'customerEmail') {
      if (emailSymbolWords.has(token)) {
        return emailSymbolWords.get(token) ?? '';
      }
      if (spokenLetterWords.has(token)) {
        return (spokenLetterWords.get(token) ?? '').toLowerCase();
      }
      if (numberWords.has(token)) {
        return numberWords.get(token) ?? '';
      }
      if (token === '@' || token === '_' || token === '.' || token === '-') {
        return token;
      }
      if (/^[a-z0-9]+$/.test(token)) {
        return token.toLowerCase();
      }
      return '';
    }

    if (captureTarget === 'phoneNumber') {
      if (numberWords.has(token)) {
        return numberWords.get(token) ?? '';
      }
      if (/^\d+$/.test(token)) {
        return token;
      }
      return '';
    }

    if (captureTarget === 'customerName') {
      if (spokenLetterWords.has(token)) {
        return (spokenLetterWords.get(token) ?? '').toLowerCase();
      }
      if (/^[a-z]+$/.test(token) && token.length === 1) {
        return token.toLowerCase();
      }
      const fuzzyName = this.fuzzyNormalizeToken(token, captureTarget);
      if (fuzzyName) {
        return fuzzyName.toLowerCase();
      }
      return '';
    }

    if (captureTarget === 'vehicleRegistration') {
      if (spokenLetterWords.has(token)) {
        return spokenLetterWords.get(token) ?? '';
      }
      if (numberWords.has(token)) {
        return numberWords.get(token) ?? '';
      }
      if (/^[a-z0-9]{1,3}$/i.test(token)) {
        return token.toUpperCase();
      }
      const fuzzyRegistration = this.fuzzyNormalizeToken(token, captureTarget);
      if (fuzzyRegistration) {
        return fuzzyRegistration.toUpperCase();
      }
      return '';
    }

    if (spokenLetterWords.has(token)) {
      return spokenLetterWords.get(token) ?? '';
    }
    if (numberWords.has(token)) {
      return numberWords.get(token) ?? '';
    }
    const fuzzyFallback = this.fuzzyNormalizeToken(token, captureTarget);
    if (fuzzyFallback) {
      return fuzzyFallback;
    }
    if (/^[a-z0-9]+$/i.test(token)) {
      return token.toUpperCase();
    }

    return '';
  }

  private fuzzyNormalizeToken(
    token: string,
    captureTarget: Exclude<CaptureSlotKey, null>,
  ): string {
    const units = this.getFuzzyUnits(captureTarget);
    if (!units.length) {
      return '';
    }

    const normalizedToken = this.normalizeForFuzzy(token);
    if (!normalizedToken || normalizedToken.length < 2) {
      return '';
    }

    const tokenSkeleton = this.getPhoneticSkeleton(normalizedToken);
    let bestMatch = '';
    let bestScore = 0;

    for (const unit of units) {
      const normalizedCandidate = this.normalizeForFuzzy(unit.spoken);
      if (!normalizedCandidate) {
        continue;
      }

      const candidateSkeleton = this.getPhoneticSkeleton(normalizedCandidate);
      if (
        tokenSkeleton &&
        candidateSkeleton &&
        tokenSkeleton[0] !== candidateSkeleton[0]
      ) {
        continue;
      }

      const exactScore = this.stringSimilarity(
        normalizedToken,
        normalizedCandidate,
      );
      const skeletonScore = this.stringSimilarity(
        tokenSkeleton,
        candidateSkeleton,
      );
      const score = exactScore * 0.28 + skeletonScore * 0.72;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = unit.output;
      }
    }

    return bestScore >= this.getFuzzyThreshold(captureTarget) ? bestMatch : '';
  }

  private getFuzzyUnits(
    captureTarget: Exclude<CaptureSlotKey, null>,
  ): CaptureUnit[] {
    switch (captureTarget) {
      case 'vehicleRegistration':
        return [...letterCaptureUnits, ...digitCaptureUnits, ...registrationMergedUnits];
      case 'customerName':
        return [...letterCaptureUnits, ...nameMergedUnits];
      case 'phoneNumber':
        return digitCaptureUnits;
      case 'customerEmail':
        return emailCaptureUnits;
      default:
        return [];
    }
  }

  private getFuzzyThreshold(
    captureTarget: Exclude<CaptureSlotKey, null>,
  ): number {
    switch (captureTarget) {
      case 'vehicleRegistration':
        return 0.8;
      case 'customerName':
        return 0.88;
      case 'customerEmail':
        return 0.9;
      case 'phoneNumber':
        return 0.94;
      default:
        return 1;
    }
  }

  private normalizeForFuzzy(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private getPhoneticSkeleton(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/[aeiouwhy]/g, '')
      .replace(/(.)\1+/g, '$1');
  }

  private stringSimilarity(left: string, right: string): number {
    if (!left && !right) {
      return 1;
    }
    if (!left || !right) {
      return 0;
    }
    if (left === right) {
      return 1;
    }

    const distance = this.levenshteinDistance(left, right);
    return 1 - distance / Math.max(left.length, right.length);
  }

  private levenshteinDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () =>
      Array.from<number>({ length: cols }).fill(0),
    );

    for (let row = 0; row < rows; row += 1) {
      matrix[row][0] = row;
    }
    for (let col = 0; col < cols; col += 1) {
      matrix[0][col] = col;
    }

    for (let row = 1; row < rows; row += 1) {
      for (let col = 1; col < cols; col += 1) {
        const substitutionCost =
          left[row - 1] === right[col - 1] ? 0 : 1;
        matrix[row][col] = Math.min(
          matrix[row - 1][col] + 1,
          matrix[row][col - 1] + 1,
          matrix[row - 1][col - 1] + substitutionCost,
        );
      }
    }

    return matrix[rows - 1][cols - 1];
  }

  private stripSlotLeadIn(text: string, patterns: RegExp[]): string {
    return patterns
      .reduce((value, pattern) => value.replace(pattern, ' '), text)
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isEmailAddress(text: string): boolean {
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text);
  }

  private toTitleCase(text: string): string {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((part) =>
        part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}` : '',
      )
      .join(' ')
      .trim();
  }
}
