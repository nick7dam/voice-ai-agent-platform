export interface PhoneValidationResult {
  ok: boolean;
  e164?: string;
  display?: string;
  reason?: string;
}

function repeatedDigits(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

function formatAustralianPhone(national: string): string {
  if (national.startsWith('04')) {
    return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
  }

  return `(${national.slice(0, 2)}) ${national.slice(2, 6)} ${national.slice(6)}`;
}

export function validateAustralianPhoneNumber(
  input: string | undefined,
): PhoneValidationResult {
  const raw = input?.trim() ?? '';

  if (!raw) {
    return {
      ok: false,
      reason: 'Phone number is missing.',
    };
  }

  const compact = raw.replace(/[^\d+]/g, '');
  if (
    (compact.match(/\+/g) ?? []).length > 1 ||
    (compact.includes('+') && !compact.startsWith('+'))
  ) {
    return {
      ok: false,
      reason: 'Phone number has an invalid plus sign.',
    };
  }

  let digits = compact.replace(/\D/g, '');

  if (digits.startsWith('61')) {
    digits = `0${digits.slice(2)}`;
  }

  if (digits.length !== 10) {
    return {
      ok: false,
      reason:
        'Australian phone numbers should be 10 digits, or start with +61.',
    };
  }

  if (repeatedDigits(digits)) {
    return {
      ok: false,
      reason: 'Phone number cannot be the same digit repeated.',
    };
  }

  if (!/^04\d{8}$/.test(digits) && !/^0[2378]\d{8}$/.test(digits)) {
    return {
      ok: false,
      reason:
        'Phone number must look like an Australian mobile or landline number.',
    };
  }

  return {
    ok: true,
    e164: `+61${digits.slice(1)}`,
    display: formatAustralianPhone(digits),
  };
}
