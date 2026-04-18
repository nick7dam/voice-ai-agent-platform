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
});
