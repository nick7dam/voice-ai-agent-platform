import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ToolDefinition,
  ToolExecutionContext,
} from '../../../common/types/tool.types';
import { MemoryService } from '../../memory/memory.service';

const schema = z.object({
  fact: z.string().min(1).max(500),
  category: z.string().max(80).optional(),
});

@Injectable()
export class RememberFactTool {
  constructor(private readonly memory: MemoryService) {}

  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'remember_fact',
    description:
      'Store a user-approved fact in the current session memory. Use only when the user asks you to remember something.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['fact'],
      properties: {
        fact: {
          type: 'string',
          description: 'The concise fact to remember for this session.',
        },
        category: {
          type: 'string',
          description: 'Optional short category for the memory fact.',
        },
      },
    },
    execute: (
      input,
      context: ToolExecutionContext,
    ): Promise<Record<string, unknown>> => {
      const saved = this.memory.rememberFact(
        context.sessionId,
        input.fact,
        input.category,
      );

      return Promise.resolve({
        remembered: true,
        memory: saved,
      });
    },
  };
}
