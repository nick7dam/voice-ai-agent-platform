import { Injectable } from '@nestjs/common';
import {
  DialogueAction,
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
  tires: [
    'tyres',
    'tires',
    'wheel alignment',
    'tyre rotation',
    'tire rotation',
  ],
  repair: ['repair', 'fix', 'not working', 'issue', 'problem'],
};

type CaptureSlotKey =
  | 'vehicleRegistration'
  | 'phoneNumber'
  | 'customerEmail'
  | 'customerName';

type PromptContext = {
  slotKey: CaptureSlotKey | null;
  action: DialogueAction | null;
};

type ExtractedSlotValue = {
  slotKey: string;
  value: string;
  canonicalValue?: string | null;
  confidence: number;
  needsConfirmation?: boolean;
};

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

const emailSymbolWords = new Map<string, string>([
  ['at', '@'],
  ['dot', '.'],
  ['period', '.'],
  ['point', '.'],
  ['underscore', '_'],
  ['dash', '-'],
  ['hyphen', '-'],
  ['minus', '-'],
  ['plus', '+'],
]);

const affirmativePattern =
  /\b(yes|yeah|yep|correct|sure|exactly|sounds right|that(?:'s| is) (?:right|correct)|it(?:'s| is) (?:right|correct))\b/i;
const negativePattern =
  /\b(no|nope|not correct|not right|wrong|incorrect|not entirely|that's wrong|that is wrong)\b/i;
const fillerPattern =
  /^(uh|um|hmm|erm|ah|mm|sorry|let me think|one sec|one second|hold on|wait)$/i;

@Injectable()
export class SemanticPatchService {
  buildPatches(
    _session: SessionState,
    profile: ConversationProfile,
    fragment: TranscriptFragment,
  ): SemanticPatch[] {
    const text = fragment.normalizedText;
    const substantive = this.hasSubstantiveContent(text);

    const patches: SemanticPatch[] = [
      {
        type: 'append_thought_fragment',
        fragmentId: fragment.id,
        text,
        at: fragment.receivedAt,
      },
      {
        type: 'set_floor',
        state: 'user_thinking',
        stability: substantive ? 0.72 : 0.3,
        at: fragment.receivedAt,
      },
      {
        type: 'mark_pending_thought',
        status: substantive ? 'ready' : 'forming',
        incompleteReason: substantive ? null : 'filler_only',
        holdUntil: null,
      },
    ];

    if (profile.key === 'car_booking_receptionist' && substantive) {
      patches.push({
        type: 'set_intent',
        intentName: profile.intentName,
        confidence: 0.72,
        status: 'forming',
        fragmentId: fragment.id,
        at: fragment.receivedAt,
      });
    }

    return patches;
  }

  buildCommittedThoughtPatches(
    session: SessionState,
    profile: ConversationProfile,
    committedText: string,
  ): SemanticPatch[] {
    if (profile.key === 'generic') {
      return [];
    }

    const now = nowIso();
    const patches: SemanticPatch[] = [];
    const promptContext = this.resolvePromptContext(session);
    const normalizedText = committedText.replace(/\s+/g, ' ').trim();
    const lower = normalizedText.toLowerCase();
    const promptedConfirmation =
      promptContext.slotKey !== null && promptContext.action === 'confirm';
    const isAffirmativeConfirmation =
      promptedConfirmation && affirmativePattern.test(lower);
    const isNegativeConfirmation =
      promptedConfirmation && negativePattern.test(lower);

    if (promptContext.slotKey && isAffirmativeConfirmation) {
      patches.push({
        type: 'confirm_slot',
        slotKey: promptContext.slotKey,
        at: now,
      });
    } else if (promptContext.slotKey && isNegativeConfirmation) {
      patches.push({
        type: 'clear_slot',
        slotKey: promptContext.slotKey,
        at: now,
      });
    }

    const shouldSkipSlotExtraction =
      isAffirmativeConfirmation || isNegativeConfirmation;

    if (!shouldSkipSlotExtraction && !this.isPureConfirmationReply(lower)) {
      for (const slot of this.extractCarBookingSlots(session, normalizedText, promptContext)) {
        patches.push({
          type: 'upsert_slot',
          slotKey: slot.slotKey,
          value: slot.value,
          canonicalValue: slot.canonicalValue,
          confidence: slot.confidence,
          status: slot.needsConfirmation ? 'provisional' : 'confirmed',
          needsConfirmation: slot.needsConfirmation,
          fragmentId: `commit:${session.id}:${now}`,
          at: now,
        });
      }
    }

    if (this.hasBookingSignal(normalizedText, patches)) {
      patches.push({
        type: 'set_intent',
        intentName: profile.intentName,
        confidence: 0.88,
        status: 'usable',
        fragmentId: `commit:${session.id}:${now}`,
        at: now,
      });
    }

    return patches;
  }

  private hasSubstantiveContent(text: string): boolean {
    const normalized = text.trim();
    return Boolean(normalized) && !fillerPattern.test(normalized);
  }

  private isPureConfirmationReply(lower: string): boolean {
    const normalized = lower.replace(/[.!?]/g, '').trim();
    if (!normalized) {
      return true;
    }

    const genericReplies = [
      'yes',
      'yeah',
      'yep',
      'correct',
      'sure',
      'exactly',
      'no',
      'nope',
      'not correct',
      'not right',
      'wrong',
      'incorrect',
      'not entirely',
      "that's wrong",
      'that is wrong',
    ];

    return genericReplies.includes(normalized);
  }

  private resolvePromptContext(session: SessionState): PromptContext {
    const prompt = session.conversation?.liveIntent.prompt;
    if (
      prompt?.slotKey &&
      (prompt.slotKey === 'vehicleRegistration' ||
        prompt.slotKey === 'phoneNumber' ||
        prompt.slotKey === 'customerEmail' ||
        prompt.slotKey === 'customerName')
    ) {
      return {
        slotKey: prompt.slotKey,
        action: prompt.action,
      };
    }

    const assistantText =
      session.assistantDraftTurn?.text ??
      session.interruptedAssistantTurn?.text ??
      '';
    const lower = assistantText.toLowerCase();
    const action: DialogueAction | null =
      /\b(is that right|is that correct|did i get that right|please confirm)\b/.test(
        lower,
      )
        ? 'confirm'
        : /\b(?:what is|can i get|what day|what time|would you like to add)\b/.test(
              lower,
            )
          ? 'ask'
          : null;

    if (/\b(rego|registration|plate)\b/.test(lower)) {
      return { slotKey: 'vehicleRegistration', action };
    }
    if (/\b(phone|mobile|number)\b/.test(lower)) {
      return { slotKey: 'phoneNumber', action };
    }
    if (/\b(email|e-mail)\b/.test(lower)) {
      return { slotKey: 'customerEmail', action };
    }
    if (/\bname\b/.test(lower)) {
      return { slotKey: 'customerName', action };
    }

    return {
      slotKey: null,
      action: null,
    };
  }

  private hasBookingSignal(text: string, patches: SemanticPatch[]): boolean {
    const lower = text.toLowerCase();
    return (
      /\b(book|booking|service|rego|registration|oil change|logbook|phone|email)\b/.test(
        lower,
      ) ||
      patches.some((patch) => patch.type === 'upsert_slot')
    );
  }

  private extractCarBookingSlots(
    session: SessionState,
    text: string,
    promptContext: PromptContext,
  ): ExtractedSlotValue[] {
    const updates: ExtractedSlotValue[] = [];

    const serviceType = this.extractServiceType(text);
    if (serviceType) {
      updates.push({
        slotKey: 'serviceType',
        value: serviceType.label,
        canonicalValue: serviceType.key,
        confidence: 0.94,
      });
    }

    const registration = this.extractRegistration(text, promptContext.slotKey === 'vehicleRegistration');
    if (registration) {
      const mergedRegistration = this.mergeRegistrationContinuation(
        session,
        promptContext,
        text,
        registration,
      );
      updates.push({
        slotKey: 'vehicleRegistration',
        value: mergedRegistration.value,
        canonicalValue: mergedRegistration.value,
        confidence: mergedRegistration.confidence,
        needsConfirmation: mergedRegistration.needsConfirmation,
      });
    }

    const name = this.extractCustomerName(text, promptContext.slotKey === 'customerName');
    if (name) {
      updates.push({
        slotKey: 'customerName',
        value: name.value,
        canonicalValue: name.value,
        confidence: name.confidence,
      });
    }

    const phone = this.extractPhoneNumber(text, promptContext.slotKey === 'phoneNumber');
    if (phone) {
      updates.push({
        slotKey: 'phoneNumber',
        value: phone.display,
        canonicalValue: phone.canonical,
        confidence: phone.confidence,
        needsConfirmation: phone.needsConfirmation,
      });
    }

    const email = this.extractCustomerEmail(text, promptContext.slotKey === 'customerEmail');
    if (email) {
      updates.push({
        slotKey: 'customerEmail',
        value: email.value,
        canonicalValue: email.value,
        confidence: email.confidence,
        needsConfirmation: email.needsConfirmation,
      });
    }

    const preferredDate = this.extractPreferredDate(text);
    if (preferredDate) {
      updates.push({
        slotKey: 'preferredDate',
        value: preferredDate,
        canonicalValue: preferredDate,
        confidence: 0.9,
      });
    }

    const preferredTime = this.extractPreferredTime(text);
    if (preferredTime) {
      updates.push({
        slotKey: 'preferredTime',
        value: preferredTime,
        canonicalValue: preferredTime,
        confidence: 0.88,
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
          label: key.replace(/_/g, ' '),
        };
      }
    }

    return null;
  }

  private extractRegistration(
    text: string,
    captureTarget: boolean,
  ): { value: string; confidence: number; needsConfirmation: boolean } | null {
    const explicit =
      /\b(rego|registration|plate)\b/i.test(text) || captureTarget;
    if (!explicit) {
      return null;
    }

    const direct = this.extractPlateToken(text);
    if (direct) {
      return {
        value: direct,
        confidence: captureTarget ? 0.88 : 0.93,
        needsConfirmation: captureTarget && !/\b(rego|registration|plate)\b/i.test(text),
      };
    }

    const spoken = this.extractMappedSequence(
      text,
      'vehicleRegistration',
      captureTarget,
    );
    if (spoken.length < 3) {
      return null;
    }

    return {
      value: spoken,
      confidence: 0.76,
      needsConfirmation: true,
    };
  }

  private mergeRegistrationContinuation(
    session: SessionState,
    promptContext: PromptContext,
    text: string,
    candidate: { value: string; confidence: number; needsConfirmation: boolean },
  ): { value: string; confidence: number; needsConfirmation: boolean } {
    if (promptContext.slotKey !== 'vehicleRegistration') {
      return candidate;
    }

    const current =
      session.conversation?.liveIntent.slots.vehicleRegistration;
    const currentValue = current?.canonicalValue ?? current?.value;
    if (
      !currentValue ||
      !current?.needsConfirmation ||
      current.status === 'confirmed'
    ) {
      return candidate;
    }

    const normalizedCurrent = currentValue.toUpperCase();
    const normalizedCandidate = candidate.value.toUpperCase();
    if (
      !normalizedCurrent ||
      !normalizedCandidate ||
      normalizedCurrent === normalizedCandidate
    ) {
      return candidate;
    }

    if (
      normalizedCurrent.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedCurrent)
    ) {
      return {
        value:
          normalizedCandidate.length >= normalizedCurrent.length
            ? normalizedCandidate
            : normalizedCurrent,
        confidence: Math.max(candidate.confidence, current.confidence),
        needsConfirmation: true,
      };
    }

    const compactText = text.replace(/\s+/g, ' ').trim();
    const shortContinuation = compactText.split(' ').filter(Boolean).length <= 4;
    const combined = `${normalizedCurrent}${normalizedCandidate}`;
    if (!shortContinuation || !/^[A-Z0-9]{4,8}$/.test(combined)) {
      return candidate;
    }

    return {
      value: combined,
      confidence: Math.min(Math.max(candidate.confidence, current.confidence), 0.82),
      needsConfirmation: true,
    };
  }

  private extractPhoneNumber(
    text: string,
    captureTarget: boolean,
  ):
    | {
        display: string;
        canonical: string;
        confidence: number;
        needsConfirmation: boolean;
      }
    | null {
    const explicit =
      /\b(phone|mobile|number)\b/i.test(text) || captureTarget;
    if (!explicit) {
      return null;
    }

    const scopedText = captureTarget
      ? text
      : this.extractAnswerTail(text, /\b(?:phone|mobile|number)\b/i);
    const candidate = this.extractDigitSequence(scopedText, captureTarget);
    if (candidate.length < 8 || candidate.length > 11) {
      return null;
    }

    return {
      display: this.formatPhoneNumber(candidate),
      canonical: candidate,
      confidence: /\d/.test(text) ? 0.94 : 0.8,
      needsConfirmation: !/\d/.test(text),
    };
  }

  private extractCustomerEmail(
    text: string,
    captureTarget: boolean,
  ): { value: string; confidence: number; needsConfirmation: boolean } | null {
    const explicit =
      /\b(email|e-mail)\b/i.test(text) || captureTarget;
    if (!explicit) {
      return null;
    }

    const scopedText = captureTarget
      ? text
      : this.extractAnswerTail(text, /\b(?:email|e-mail)\b/i);

    const typedMatch = scopedText.match(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    );
    if (typedMatch) {
      return {
        value: typedMatch[0].toLowerCase(),
        confidence: 0.96,
        needsConfirmation: false,
      };
    }

    const spoken = this.extractSpokenEmail(scopedText);
    if (!spoken) {
      return null;
    }

    return {
      value: spoken,
      confidence: 0.82,
      needsConfirmation: true,
    };
  }

  private extractCustomerName(
    text: string,
    captureTarget: boolean,
  ): { value: string; confidence: number } | null {
    const explicitMatch = text.match(
      /\b(?:my name is|this is|i am|i'm)\s+([A-Za-z][A-Za-z' -]{0,48})/i,
    );
    if (explicitMatch) {
      return {
        value: this.toNameCase(explicitMatch[1]),
        confidence: 0.94,
      };
    }

    if (!captureTarget) {
      return null;
    }

    const spokenLetters = this.extractMappedSequence(text, 'customerName');
    if (spokenLetters.length >= 2 && /^[A-Z]+$/.test(spokenLetters)) {
      return {
        value: this.toNameCase(spokenLetters),
        confidence: 0.8,
      };
    }

    const cleaned = text
      .replace(/[^A-Za-z' -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      return null;
    }

    if (
      ['yes', 'no', 'nope', 'correct', 'wrong', 'sorry'].includes(
        cleaned.toLowerCase(),
      )
    ) {
      return null;
    }

    const words = cleaned.split(' ').filter(Boolean);
    if (!words.length || words.length > 3) {
      return null;
    }

    return {
      value: this.toNameCase(cleaned),
      confidence: 0.86,
    };
  }

  private extractPreferredDate(text: string): string | null {
    const lower = text.toLowerCase();

    if (/\btomorrow\b/.test(lower)) {
      return 'tomorrow';
    }
    if (/\btoday\b/.test(lower)) {
      return 'today';
    }

    const nextWeekday = lower.match(
      /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    );
    if (nextWeekday) {
      return `next ${nextWeekday[1]}`;
    }

    const weekday = lower.match(
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    );
    if (weekday) {
      return weekday[1];
    }

    return null;
  }

  private extractPreferredTime(text: string): string | null {
    const match = text.match(
      /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i,
    );
    if (!match) {
      return null;
    }

    const hours = match[1];
    const minutes = match[2];
    const suffix = match[3].replace(/\./g, '').toLowerCase();
    return minutes ? `${hours}:${minutes} ${suffix}` : `${hours} ${suffix}`;
  }

  private extractAnswerTail(text: string, marker: RegExp): string {
    const match = marker.exec(text);
    if (match?.index === undefined) {
      return text;
    }

    const tail = text.slice(match.index + match[0].length);
    return tail.replace(/^\s*(?:is|for|to|at|:|-)\s*/i, '').trim();
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

  private extractDigitSequence(text: string, allowLooseAliases = false): string {
    const numericGroups = text.match(/\d+/g) ?? [];
    const directDigits = numericGroups.join('');
    if (directDigits) {
      return directDigits;
    }

    const digits: string[] = [];

    for (const rawToken of text.split(/\s+/)) {
      const token = rawToken.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!token) {
        continue;
      }

      if (/^\d+$/.test(token)) {
        digits.push(token);
        continue;
      }

      const mapped = this.mapNumberToken(token, allowLooseAliases);
      if (mapped) {
        digits.push(mapped);
      }
    }

    return digits.join('');
  }

  private extractMappedSequence(
    text: string,
    slotKey: CaptureSlotKey,
    allowLooseNumberAliases = false,
  ): string {
    const outputs: string[] = [];

    for (const rawToken of text.split(/\s+/)) {
      const token = rawToken.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!token) {
        continue;
      }

      if (slotKey !== 'phoneNumber') {
        const letter = spokenLetterWords.get(token);
        if (letter) {
          outputs.push(letter);
          continue;
        }
      }

      if (slotKey !== 'customerName') {
        if (/^\d+$/.test(token)) {
          outputs.push(token);
          continue;
        }

        const digit = this.mapNumberToken(token, allowLooseNumberAliases);
        if (digit) {
          outputs.push(digit);
          continue;
        }
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

  private extractSpokenEmail(text: string): string | null {
    const parts: string[] = [];
    for (const rawToken of text.split(/\s+/)) {
      const token = rawToken.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!token) {
        continue;
      }

      const symbol = emailSymbolWords.get(token);
      if (symbol) {
        parts.push(symbol);
        continue;
      }

      const letter = spokenLetterWords.get(token);
      if (letter) {
        parts.push(letter.toLowerCase());
        continue;
      }

      const digit = numberWords.get(token);
      if (digit) {
        parts.push(digit);
        continue;
      }

      if (/^[a-z0-9]+$/.test(token) && !this.isCommonWord(token)) {
        parts.push(token);
      }
    }

    const candidate = parts.join('');
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate)) {
      return null;
    }

    return candidate.toLowerCase();
  }

  private formatPhoneNumber(canonical: string): string {
    if (canonical.length === 10 && canonical.startsWith('04')) {
      return `${canonical.slice(0, 4)} ${canonical.slice(4, 7)} ${canonical.slice(7)}`;
    }

    if (canonical.length === 10) {
      return `${canonical.slice(0, 2)} ${canonical.slice(2, 6)} ${canonical.slice(6)}`;
    }

    return canonical;
  }

  private toNameCase(value: string): string {
    return value
      .trim()
      .split(/\s+/)
      .map((word) =>
        word
          .split(/([-'])/)
          .map((part) =>
            /^[-']$/.test(part)
              ? part
              : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
          )
          .join(''),
      )
      .join(' ');
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
      'correct',
      'wrong',
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
}
