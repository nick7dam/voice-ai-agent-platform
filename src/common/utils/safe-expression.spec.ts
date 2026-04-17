import { evaluateSafeExpression } from './safe-expression';

describe('evaluateSafeExpression', () => {
  it('calculates arithmetic without eval', () => {
    expect(evaluateSafeExpression('2 + 3 * (4 - 1)')).toBe(11);
  });

  it('rejects unsafe input', () => {
    expect(() => evaluateSafeExpression('process.exit()')).toThrow(
      'Expression can only contain numbers',
    );
  });
});
