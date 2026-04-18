import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ToolDefinition,
  ToolExecutionContext,
} from '../../../common/types/tool.types';
import { validateAustralianPhoneNumber } from '../../../common/utils/phone-number';
import { MemoryService } from '../../memory/memory.service';

const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).optional();

const schema = z.object({
  customerName: optionalText(120),
  phone: optionalText(40),
  vehicle: optionalText(160),
  registration: optionalText(24),
  serviceType: optionalText(120),
  preferredDate: optionalText(80),
  preferredTime: optionalText(40),
  notes: optionalText(300),
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
          description:
            'Customer Australian phone number. Only include it when clearly heard; otherwise ask the customer to repeat it.',
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
      const phoneResult = input.phone
        ? validateAustralianPhoneNumber(input.phone)
        : undefined;
      const normalizedInput = {
        ...input,
        phone: phoneResult?.ok ? phoneResult.display : undefined,
      };
      const invalidFields =
        phoneResult && !phoneResult.ok
          ? [
              {
                field: 'phone',
                value: input.phone,
                reason: phoneResult.reason,
              },
            ]
          : [];
      const captured = Object.entries(normalizedInput)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([field, value]) => ({
          field,
          value: String(value).trim(),
        }));

      if (captured.length === 0) {
        return Promise.resolve({
          capturedFields: [],
          invalidFields,
          bookingReady: false,
          missingForBooking: this.missingForBooking(normalizedInput),
          instruction:
            invalidFields.length > 0
              ? 'The phone number was invalid or incomplete. Ask the customer to repeat it digit by digit.'
              : 'No customer details were supplied. Ask one short question for the next required booking detail.',
        });
      }

      for (const item of captured) {
        this.memory.rememberFact(
          context.sessionId,
          `${this.humanFieldName(item.field)}: ${item.value}`,
          'customer_detail',
        );
      }

      const missingForBooking = this.missingForBooking(normalizedInput);
      return Promise.resolve({
        capturedFields: captured,
        invalidFields,
        bookingReady: missingForBooking.length === 0,
        missingForBooking,
        instruction:
          invalidFields.length > 0
            ? 'Acknowledge any captured details briefly, then ask the customer to repeat the phone number digit by digit.'
            : missingForBooking.length === 0
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
