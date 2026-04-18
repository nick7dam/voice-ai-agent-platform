import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ToolDefinition,
  ToolExecutionContext,
} from '../../../common/types/tool.types';
import { validateAustralianPhoneNumber } from '../../../common/utils/phone-number';
import { MemoryService } from '../../memory/memory.service';
import {
  carServiceBusiness,
  nextAvailability,
  serviceTypes,
} from './car-service-data';

const schema = z.object({
  customerName: z.string().min(1).max(120).optional(),
  phone: z.string().min(5).max(40).optional(),
  vehicle: z.string().min(1).max(160).optional(),
  serviceType: z.string().min(1).max(120).optional(),
  preferredDate: z.string().max(80).optional(),
  preferredTime: z.string().max(40).optional(),
  notes: z.string().max(300).optional(),
});

@Injectable()
export class CreateServiceBookingTool {
  constructor(private readonly memory: MemoryService) {}

  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'create_service_booking',
    description:
      'Create a provisional car service booking after collecting customer name, phone, vehicle, service type, and preferred date/time.',
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
          description: 'Vehicle details, such as year, make, model, and rego.',
        },
        serviceType: {
          type: 'string',
          description: 'Requested service type.',
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
          description: 'Optional customer notes or symptoms.',
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
      const missingFields = this.missingRequiredFields(normalizedInput);

      if (missingFields.length > 0 || invalidFields.length > 0) {
        return Promise.resolve({
          bookingCreated: false,
          missingFields,
          invalidFields,
          supportedServices: serviceTypes,
          suggestedSlots: nextAvailability({ limit: 3 }),
          instruction:
            invalidFields.length > 0
              ? 'The phone number is invalid or incomplete. Ask the customer to repeat it digit by digit before creating the booking.'
              : 'Ask the customer for the missing fields before creating the booking.',
        });
      }

      const bookingReference = this.bookingReference(context.sessionId);
      const booking = {
        bookingCreated: true,
        bookingReference,
        businessName: carServiceBusiness.name,
        customerName: normalizedInput.customerName,
        phone: normalizedInput.phone,
        vehicle: normalizedInput.vehicle,
        serviceType: normalizedInput.serviceType,
        preferredDate: normalizedInput.preferredDate,
        preferredTime: normalizedInput.preferredTime,
        notes: normalizedInput.notes ?? null,
        status: 'provisional',
        instruction:
          'Tell the customer this is provisionally booked and the workshop can confirm if needed.',
      };

      this.memory.rememberFact(
        context.sessionId,
        `Provisional booking ${bookingReference}: ${normalizedInput.customerName}, ${normalizedInput.vehicle}, ${normalizedInput.serviceType}, ${normalizedInput.preferredDate} at ${normalizedInput.preferredTime}. Phone ${normalizedInput.phone}.`,
        'booking',
      );

      return Promise.resolve(booking);
    },
  };

  private missingRequiredFields(input: z.infer<typeof schema>): string[] {
    const requiredFields: Array<{ field: string; value?: string }> = [
      { field: 'customerName', value: input.customerName },
      { field: 'phone', value: input.phone },
      { field: 'vehicle', value: input.vehicle },
      { field: 'serviceType', value: input.serviceType },
      { field: 'preferredDate', value: input.preferredDate },
      { field: 'preferredTime', value: input.preferredTime },
    ];

    return requiredFields
      .filter((item) => !item.value)
      .map((item) => item.field);
  }

  private bookingReference(sessionId: string): string {
    const suffix = sessionId.replace(/-/g, '').slice(0, 6).toUpperCase();
    const time = Date.now().toString(36).slice(-5).toUpperCase();
    return `NSA-${suffix}-${time}`;
  }
}
