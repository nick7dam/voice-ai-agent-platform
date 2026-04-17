import { AppError } from '../types/errors';

type TokenType = 'number' | 'operator' | 'leftParen' | 'rightParen' | 'eof';

interface Token {
  type: TokenType;
  value?: string;
}

class ExpressionTokenizer {
  private index = 0;

  constructor(private readonly input: string) {}

  next(): Token {
    while (
      this.index < this.input.length &&
      /\s/.test(this.input[this.index])
    ) {
      this.index += 1;
    }

    if (this.index >= this.input.length) {
      return { type: 'eof' };
    }

    const current = this.input[this.index];

    if (/[0-9.]/.test(current)) {
      const start = this.index;
      let dotCount = 0;

      while (
        this.index < this.input.length &&
        /[0-9.]/.test(this.input[this.index])
      ) {
        if (this.input[this.index] === '.') {
          dotCount += 1;
        }
        this.index += 1;
      }

      const value = this.input.slice(start, this.index);
      if (dotCount > 1 || value === '.') {
        throw new AppError(
          'INVALID_EXPRESSION',
          'Invalid number in expression.',
        );
      }
      return { type: 'number', value };
    }

    if ('+-*/%'.includes(current)) {
      this.index += 1;
      return { type: 'operator', value: current };
    }

    if (current === '(') {
      this.index += 1;
      return { type: 'leftParen', value: current };
    }

    if (current === ')') {
      this.index += 1;
      return { type: 'rightParen', value: current };
    }

    throw new AppError(
      'INVALID_EXPRESSION',
      'Expression can only contain numbers, whitespace, parentheses, and + - * / % operators.',
    );
  }
}

class ExpressionParser {
  private current: Token;

  constructor(private readonly tokenizer: ExpressionTokenizer) {
    this.current = this.tokenizer.next();
  }

  parse(): number {
    const result = this.parseExpression();
    if (this.current.type !== 'eof') {
      throw new AppError('INVALID_EXPRESSION', 'Unexpected trailing input.');
    }
    if (!Number.isFinite(result)) {
      throw new AppError(
        'INVALID_EXPRESSION',
        'Expression result is not finite.',
      );
    }
    return result;
  }

  private parseExpression(): number {
    let value = this.parseTerm();

    while (
      this.current.type === 'operator' &&
      (this.current.value === '+' || this.current.value === '-')
    ) {
      const operator = this.current.value;
      this.advance();
      const right = this.parseTerm();
      value = operator === '+' ? value + right : value - right;
    }

    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();

    while (
      this.current.type === 'operator' &&
      ['*', '/', '%'].includes(this.current.value ?? '')
    ) {
      const operator = this.current.value;
      this.advance();
      const right = this.parseFactor();

      if ((operator === '/' || operator === '%') && right === 0) {
        throw new AppError(
          'INVALID_EXPRESSION',
          'Division by zero is not allowed.',
        );
      }

      if (operator === '*') {
        value *= right;
      } else if (operator === '/') {
        value /= right;
      } else {
        value %= right;
      }
    }

    return value;
  }

  private parseFactor(): number {
    if (this.current.type === 'operator' && this.current.value === '-') {
      this.advance();
      return -this.parseFactor();
    }

    if (this.current.type === 'operator' && this.current.value === '+') {
      this.advance();
      return this.parseFactor();
    }

    if (this.current.type === 'number') {
      const value = Number(this.current.value);
      this.advance();
      return value;
    }

    if (this.current.type === 'leftParen') {
      this.advance();
      const value = this.parseExpression();
      this.advance();
      return value;
    }

    throw new AppError(
      'INVALID_EXPRESSION',
      'Expected a number or parenthesized expression.',
    );
  }

  private advance(): void {
    this.current = this.tokenizer.next();
  }
}

export function evaluateSafeExpression(expression: string): number {
  if (expression.length > 200) {
    throw new AppError('INVALID_EXPRESSION', 'Expression is too long.');
  }

  return new ExpressionParser(new ExpressionTokenizer(expression)).parse();
}
