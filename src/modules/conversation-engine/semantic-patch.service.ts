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

const numberWords = new Map<string, string>([
  ['zero', '0'],
  ['oh', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9'],
]);

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
    const incompleteReason = this.detectIncompleteThought(profile, combinedThought);

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

    const slotUpdates = this.extractCarBookingSlots(combinedThought);
    for (const slotUpdate of slotUpdates) {
      patches.push({
        type: 'upsert_slot',
        slotKey: slotUpdate.slotKey,
        value: slotUpdate.value,
        canonicalValue: slotUpdate.canonicalValue,
        confidence: slotUpdate.confidence,
        status: 'provisional',
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
      !this.extractRegistration(lower)
    ) {
      return 'registration_incomplete';
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

  private extractCarBookingSlots(text: string): Array<{
    slotKey: string;
    value: string;
    canonicalValue?: string | null;
    confidence: number;
  }> {
    const updates: Array<{
      slotKey: string;
      value: string;
      canonicalValue?: string | null;
      confidence: number;
    }> = [];

    const serviceType = this.extractServiceType(text);
    if (serviceType) {
      updates.push({
        slotKey: 'serviceType',
        value: serviceType.label,
        canonicalValue: serviceType.key,
        confidence: 0.92,
      });
    }

    const registration = this.extractRegistration(text);
    if (registration) {
      updates.push({
        slotKey: 'vehicleRegistration',
        value: registration,
        canonicalValue: registration,
        confidence: 0.9,
      });
    }

    const name = this.extractCustomerName(text);
    if (name) {
      updates.push({
        slotKey: 'customerName',
        value: name,
        canonicalValue: name,
        confidence: 0.78,
      });
    }

    const phoneNumber = this.extractPhoneNumber(text);
    if (phoneNumber) {
      updates.push({
        slotKey: 'phoneNumber',
        value: phoneNumber.display,
        canonicalValue: phoneNumber.canonical,
        confidence: phoneNumber.confidence,
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

  private extractCustomerName(text: string): string | null {
    const match = text.match(
      /\b(?:my name is|this is|i am|i'm)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\b/i,
    );
    return match?.[1]
      ?.trim()
      .split(/\s+/)
      .map((part) =>
        part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}` : '',
      )
      .join(' ')
      .trim() ?? null;
  }

  private extractPhoneNumber(text: string): {
    canonical: string;
    display: string;
    confidence: number;
  } | null {
    const lower = text.toLowerCase();
    if (!/\b(phone|mobile|number|call me on|reach me on|best number)\b/.test(lower)) {
      return null;
    }

    const digits = this.extractDigitString(lower);
    if (digits.length < 8) {
      return null;
    }

    const canonical = digits.slice(0, 12);
    return {
      canonical,
      display: canonical.replace(/(\d{4})(?=\d)/g, '$1 ').trim(),
      confidence: canonical.length >= 10 ? 0.94 : 0.68,
    };
  }

  private extractRegistration(text: string): string | null {
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
      return candidate;
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

  private extractDigitString(text: string): string {
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
}
