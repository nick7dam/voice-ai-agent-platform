const smallNumbers = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const tensNumbers: Record<number, string> = {
  20: 'twenty',
  30: 'thirty',
  40: 'forty',
  50: 'fifty',
};

const stateNames: Record<string, string> = {
  ACT: 'Australian Capital Territory',
  NSW: 'New South Wales',
  NT: 'Northern Territory',
  QLD: 'Queensland',
  SA: 'South Australia',
  TAS: 'Tasmania',
  VIC: 'Victoria',
  WA: 'Western Australia',
};

export function normalizeTextForSpeech(text: string): string {
  return text
    .replace(
      /\b([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)?\b/gi,
      (_match: string, hour: string, minute: string, meridiem?: string) =>
        formatTimeForSpeech(Number(hour), Number(minute), meridiem),
    )
    .replace(
      /\b(0?[1-9]|1[0-2])\s*(a\.?m\.?|p\.?m\.?)\b/gi,
      (_match: string, hour: string, meridiem: string) =>
        formatTimeForSpeech(Number(hour), 0, meridiem),
    )
    .replace(/\b(?:a\.?m\.?)\b/gi, 'in the morning')
    .replace(/\b(?:p\.?m\.?)\b/gi, 'in the afternoon')
    .replace(
      /\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b/g,
      (match) => stateNames[match] ?? match,
    )
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimeForSpeech(
  rawHour: number,
  minute: number,
  rawMeridiem?: string,
): string {
  const meridiem = parseMeridiem(rawMeridiem);

  if (meridiem === 'am' && rawHour === 12 && minute === 0) {
    return 'midnight';
  }

  if (meridiem === 'pm' && rawHour === 12 && minute === 0) {
    return 'midday';
  }

  const hour24 = meridiem
    ? toTwentyFourHour(rawHour, meridiem)
    : normalizeTwentyFourHour(rawHour);
  const hour12 = hour24 % 12 || 12;
  const hourText = numberToWordsUnderSixty(hour12);
  const period = meridiem ? periodForHour(hour24) : '';

  if (minute === 0) {
    return period ? `${hourText} ${period}` : `${hourText} o'clock`;
  }

  const minuteText =
    minute < 10
      ? `oh ${numberToWordsUnderSixty(minute)}`
      : numberToWordsUnderSixty(minute);

  return [hourText, minuteText, period].filter(Boolean).join(' ');
}

function parseMeridiem(value?: string): 'am' | 'pm' | undefined {
  if (!value) {
    return undefined;
  }

  return value.toLowerCase().startsWith('a') ? 'am' : 'pm';
}

function toTwentyFourHour(hour: number, meridiem: 'am' | 'pm'): number {
  const normalized = hour % 12;
  return meridiem === 'am' ? normalized : normalized + 12;
}

function normalizeTwentyFourHour(hour: number): number {
  return hour >= 0 && hour <= 23 ? hour : hour % 24;
}

function periodForHour(hour24: number): string {
  if (hour24 < 5) {
    return 'at night';
  }

  if (hour24 < 12) {
    return 'in the morning';
  }

  if (hour24 < 17) {
    return 'in the afternoon';
  }

  return 'in the evening';
}

function numberToWordsUnderSixty(value: number): string {
  if (value < smallNumbers.length) {
    return smallNumbers[value];
  }

  const tens = Math.floor(value / 10) * 10;
  const ones = value % 10;
  return ones === 0
    ? tensNumbers[tens]
    : `${tensNumbers[tens]} ${smallNumbers[ones]}`;
}
