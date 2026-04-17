import { Injectable, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { AppError, toErrorPayload } from '../../common/types/errors';
import {
  NormalizedToolResult,
  ToolCall,
  ToolExecutionContext,
} from '../../common/types/tool.types';
import { elapsedMs } from '../../common/utils/timing';
import { ToolRegistryService } from './tool-registry.service';

@Injectable()
export class ToolRuntimeService {
  private readonly logger = new Logger(ToolRuntimeService.name);

  constructor(private readonly registry: ToolRegistryService) {}

  async execute(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    allowedTools: string[],
  ): Promise<NormalizedToolResult> {
    const startedAt = process.hrtime.bigint();

    try {
      if (!allowedTools.includes(toolCall.name)) {
        throw new AppError(
          'TOOL_NOT_ALLOWED',
          `Tool ${toolCall.name} is not allowed for this task.`,
        );
      }

      const tool = this.registry.get(toolCall.name);
      const parsedInput = tool.inputSchema.parse(toolCall.arguments);
      this.logger.log(
        `tool.called session=${context.sessionId} name=${tool.name}`,
      );
      const output = await tool.execute(parsedInput, context);
      const latencyMs = elapsedMs(startedAt);
      this.logger.log(
        `tool.result session=${context.sessionId} name=${tool.name} ok=true latencyMs=${latencyMs}`,
      );

      return {
        toolCallId: toolCall.id,
        name: tool.name,
        ok: true,
        output,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = elapsedMs(startedAt);
      const payload =
        error instanceof ZodError
          ? {
              code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
              message: 'Tool arguments did not match the expected schema.',
              details: error.issues,
              recoverable: true,
            }
          : toErrorPayload(error);

      this.logger.warn(
        `tool.result session=${context.sessionId} name=${toolCall.name} ok=false code=${payload.code} latencyMs=${latencyMs}`,
      );

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        error: {
          code: payload.code,
          message: payload.message,
          details: payload.details,
        },
        latencyMs,
      };
    }
  }
}
