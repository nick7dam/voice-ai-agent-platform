import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ToolDefinition } from '../../../common/types/tool.types';
import {
  carServiceBusiness,
  nextAvailability,
  serviceCatalog,
  serviceTypes,
} from './car-service-data';

const schema = z.object({
  serviceType: z.string().max(120).optional(),
  date: z.string().max(80).optional(),
  preferredTimeOfDay: z.enum(['morning', 'afternoon', 'any']).default('any'),
});

@Injectable()
export class CheckServiceAvailabilityTool {
  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'check_service_availability',
    description:
      'Check available appointment slots for car servicing. Use before offering appointment times or making a booking.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serviceType: {
          type: 'string',
          description:
            'Requested service, such as logbook service, oil change, brakes, tyres, or diagnostic check.',
        },
        date: {
          type: 'string',
          description:
            'Optional preferred date, such as today, tomorrow, or 2026-04-20.',
        },
        preferredTimeOfDay: {
          type: 'string',
          enum: ['morning', 'afternoon', 'any'],
          description: 'Preferred part of the day.',
        },
      },
    },
    execute: (input) =>
      Promise.resolve({
        businessName: carServiceBusiness.name,
        serviceType: input.serviceType ?? 'general service',
        supportedServices: serviceTypes,
        serviceCatalog,
        slots: nextAvailability({
          date: input.date,
          preferredTimeOfDay: input.preferredTimeOfDay,
          limit: 5,
        }),
        note: 'These are demo availability slots. Confirm with the customer before creating a booking.',
      }),
  };
}
