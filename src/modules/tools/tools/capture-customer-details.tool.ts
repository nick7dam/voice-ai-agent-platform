import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ToolDefinition,
  ToolExecutionContext,
} from '../../../common/types/tool.types';
import { MemoryService } from '../../memory/memory.service';

const schema = z.object({
  customerName: z.string().min(1).max(120),
  phone: z.string().min(5).max(40),
  vehicle: z.string().min(1).max(160),
  registration: z.string().min(1).max(24),
  serviceType: z.string().min(1).max(120),
  preferredDate: z.string().max(80),
  preferredTime: z.string().max(40),
  notes: z.string().max(300).optional(),
});

@Injectable()
export class CaptureCustomerDetailsTool {
  constructor(private readonly memory: MemoryService) {}

  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'capture_customer_details',
    description:
      'Save customer, vehicle, service, and preferred booking details collected during a car service receptionist call.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerName: {
          type: 'string',
          description: 'Customer full name.',
        },
        phone: {
          type: 'string',
          description: 'Customer phone number.',
        },
        vehicle: {
          type: 'string',
          description: 'Vehicle details, such as year, make, and model.',
        },
        registration: {
          type: 'string',
          description: 'Vehicle registration or plate number.',
        },
        serviceType: {
          type: 'string',
          description: 'Requested service type or issue.',
        },
        preferredDate: {
          type: 'string',
          description: 'Preferred appointment date.',
        },
        preferredTime: {
          type: 'string',
          description: 'Preferred appointment time.',
        },
        notes: {
          type: 'string',
          description: 'Other relevant notes or symptoms.',
        },
      },
    },
    execute: (input, context: ToolExecutionContext) => {
      const captured = Object.entries(input)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([field, value]) => ({
          field,
          value: String(value).trim(),
        }));

      if (captured.length === 0) {
        return Promise.resolve({
          capturedFields: [],
          bookingReady: false,
          missingForBooking: this.missingForBooking(input),
          instruction:
            'No customer details were supplied. Ask one short question for the next required booking detail.',
        });
      }

      for (const item of captured) {
        this.memory.rememberFact(
          context.sessionId,
          `${this.humanFieldName(item.field)}: ${item.value}`,
          'customer_detail',
        );
      }

      const missingForBooking = this.missingForBooking(input);
      return Promise.resolve({
        capturedFields: captured,
        bookingReady: missingForBooking.length === 0,
        missingForBooking,
        instruction:
          missingForBooking.length === 0
            ? 'The details needed for a provisional booking are available. Check availability before creating the booking.'
            : 'Acknowledge the captured detail briefly, then ask one short question for the next missing booking detail.',
      });
    },
  };

  private missingForBooking(input: z.infer<typeof schema>): string[] {
    const requiredFields: Array<{ field: string; value?: string }> = [
      { field: 'customerName', value: input.customerName },
      { field: 'phone', value: input.phone },
      { field: 'vehicle', value: input.vehicle },
      { field: 'serviceType', value: input.serviceType },
      { field: 'preferredDate', value: input.preferredDate },
      { field: 'preferredTime', value: input.preferredTime },
    ];

    return requiredFields
      .filter((item) => !item.value?.trim())
      .map((item) => item.field);
  }

  private humanFieldName(field: string): string {
    return field.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
  }
}
