import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ToolDefinition,
  ToolExecutionContext,
} from '../../../common/types/tool.types';
import { MemoryService } from '../../memory/memory.service';

const schema = z.object({
  limit: z.number().int().positive().max(20).optional(),
});

@Injectable()
export class ListMemoryTool {
  constructor(private readonly memory: MemoryService) {}

  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'list_memory',
    description: 'List facts remembered in the current session.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of memory facts to return.',
        },
      },
    },
    execute: (input, context: ToolExecutionContext) =>
      Promise.resolve({
        memory: this.memory.listMemory(context.sessionId, input.limit ?? 10),
      }),
  };
}
