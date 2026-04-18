import { validateAustralianPhoneNumber } from './phone-number';

describe('validateAustralianPhoneNumber', () => {
  it('normalizes Australian mobile numbers', () => {
    expect(validateAustralianPhoneNumber('0412 345 678')).toMatchObject({
      ok: true,
      e164: '+61412345678',
      display: '0412 345 678',
    });
  });

  it('normalizes +61 landline numbers', () => {
    expect(validateAustralianPhoneNumber('+61 3 9123 4567')).toMatchObject({
      ok: true,
      e164: '+61391234567',
      display: '(03) 9123 4567',
    });
  });

  it('rejects incomplete or non-Australian numbers', () => {
    expect(validateAustralianPhoneNumber('12345')).toMatchObject({
      ok: false,
    });
    expect(validateAustralianPhoneNumber('+1 555 123 4567')).toMatchObject({
      ok: false,
    });
  });
});
