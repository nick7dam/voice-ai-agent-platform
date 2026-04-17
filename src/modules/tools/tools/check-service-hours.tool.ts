import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ToolDefinition } from '../../../common/types/tool.types';
import {
  carServiceBusiness,
  carServiceHours,
  dayName,
  formatDate,
  hoursForDate,
  parseRequestedDate,
} from './car-service-data';

const schema = z.object({
  date: z.string().max(80).optional(),
});

@Injectable()
export class CheckServiceHoursTool {
  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'check_service_hours',
    description:
      'Check the car service workshop opening hours. Provide a date when the customer asks about a specific day.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: {
          type: 'string',
          description:
            'Optional requested date, such as today, tomorrow, or 2026-04-20.',
        },
      },
    },
    execute: (input) => {
      const requestedDate = parseRequestedDate(input.date);
      const requestedHours = requestedDate
        ? hoursForDate(requestedDate)
        : undefined;

      return Promise.resolve({
        businessName: carServiceBusiness.name,
        timeZone: carServiceBusiness.timeZone,
        requestedDate: requestedDate
          ? {
              date: formatDate(requestedDate),
              day: dayName(requestedDate),
              open: requestedHours?.closed ? null : requestedHours?.open,
              close: requestedHours?.closed ? null : requestedHours?.close,
              closed: Boolean(requestedHours?.closed),
            }
          : null,
        weeklyHours: carServiceHours,
      });
    },
  };
}
