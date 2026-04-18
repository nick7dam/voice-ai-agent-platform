import { normalizeTextForSpeech } from './speech-text-normalizer';

describe('normalizeTextForSpeech', () => {
  it('speaks exact PM hours naturally', () => {
    expect(normalizeTextForSpeech('The time is 2:00 PM.')).toBe(
      'The time is two in the afternoon.',
    );
  });

  it('speaks non-exact times naturally', () => {
    expect(normalizeTextForSpeech('Your booking is at 9:05am.')).toBe(
      'Your booking is at nine oh five in the morning.',
    );
  });

  it('handles midday and midnight', () => {
    expect(normalizeTextForSpeech('Open from 12:00 PM to 12:00 AM.')).toBe(
      'Open from midday to midnight.',
    );
  });

  it('expands Australian state abbreviations', () => {
    expect(normalizeTextForSpeech('Brunswick, VIC & nearby suburbs')).toBe(
      'Brunswick, Victoria and nearby suburbs',
    );
  });

  it('expands common abbreviations for TTS', () => {
    expect(
      normalizeTextForSpeech('We can check brakes, e.g. pads, discs, etc.'),
    ).toBe('We can check brakes, for example pads, discs, and so on.');
    expect(normalizeTextForSpeech('i.e. bring the rego ASAP.')).toBe(
      'that is bring the registration as soon as possible.',
    );
  });

  it('removes assistant asides and hidden call markers from spoken text', () => {
    expect(
      normalizeTextForSpeech(
        'Thanks, your booking is sorted. (End the call now.) [[END_CALL]]',
      ),
    ).toBe('Thanks, your booking is sorted.');
  });

  it('keeps numeric phone area codes inside parentheses', () => {
    expect(normalizeTextForSpeech('Call us on (03) 9123 4567.')).toBe(
      'Call us on 03 9123 4567.',
    );
  });
});
