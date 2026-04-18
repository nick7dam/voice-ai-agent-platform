import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ToolDefinition } from '../../../common/types/tool.types';
import { normalizeTextForSpeech } from '../../../common/utils/speech-text-normalizer';

const schema = z.object({
  timeZone: z.string().optional(),
});

@Injectable()
export class GetCurrentTimeTool {
  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'get_current_time',
    description:
      'Get the current date and time. Optionally provide an IANA time zone, such as Australia/Melbourne.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeZone: {
          type: 'string',
          description: 'Optional IANA time zone.',
        },
      },
    },
    execute: (input) => {
      const now = new Date();
      const timeZone = input.timeZone;
      const resolvedTimeZone =
        timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const localTime = new Intl.DateTimeFormat('en-AU', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone,
      }).format(now);
      const localDate = new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'full',
        timeZone,
      }).format(now);

      return Promise.resolve({
        iso: now.toISOString(),
        local: new Intl.DateTimeFormat('en-US', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone,
        }).format(now),
        localTime,
        spokenTime: normalizeTextForSpeech(localTime),
        localDate,
        spokenLocal: `${normalizeTextForSpeech(localTime)} on ${localDate}`,
        timeZone: resolvedTimeZone,
      });
    },
  };
}
