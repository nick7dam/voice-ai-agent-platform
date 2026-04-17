import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ToolDefinition } from '../../../common/types/tool.types';
import { evaluateSafeExpression } from '../../../common/utils/safe-expression';

const schema = z.object({
  expression: z.string().min(1).max(200),
});

@Injectable()
export class CalculateExpressionTool {
  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'calculate_expression',
    description:
      'Safely calculate a simple arithmetic expression using numbers, parentheses, and + - * / % operators.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['expression'],
      properties: {
        expression: {
          type: 'string',
          description:
            'Arithmetic expression. Only numbers, whitespace, parentheses, and + - * / % are allowed.',
        },
      },
    },
    execute: ({ expression }) =>
      Promise.resolve({
        expression,
        result: evaluateSafeExpression(expression),
      }),
  };
}
