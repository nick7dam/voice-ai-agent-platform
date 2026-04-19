import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/types/errors';
import {
  ToolDefinition,
  ToolExecutionContext,
} from '../../../common/types/tool.types';
import { validateAustralianPhoneNumber } from '../../../common/utils/phone-number';
import { MemoryService } from '../../memory/memory.service';
import { BookingApiClient } from '../booking-api/booking-api.client';

const serviceTypeValues = [
  'inspection',
  'oil_change',
  'logbook_service',
  'brakes',
  'tyres',
  'battery',
  'engine_diagnostics',
  'transmission',
  'suspension',
  'other',
] as const;

const preferredContactValues = ['any', 'email', 'phone', 'mail'] as const;
const escalationReasonValues = [
  'customer_requested_human',
  'urgent_issue',
  'pricing_dispute',
  'unclear_audio',
  'backend_failure',
  'complaint',
  'other',
] as const;

const serviceTypeSchema = z.enum(serviceTypeValues);
const preferredContactSchema = z.enum(preferredContactValues);
const escalationReasonSchema = z.enum(escalationReasonValues);

type ServiceType = z.infer<typeof serviceTypeSchema>;
type PreferredContactMethod = z.infer<typeof preferredContactSchema>;
type EscalationReason = z.infer<typeof escalationReasonSchema>;

const serviceTypeToApi: Record<ServiceType, number> = {
  inspection: 0,
  oil_change: 1,
  logbook_service: 2,
  brakes: 3,
  tyres: 4,
  battery: 5,
  engine_diagnostics: 6,
  transmission: 7,
  suspension: 8,
  other: 9,
};

const preferredContactToApi: Record<PreferredContactMethod, number> = {
  any: 0,
  email: 1,
  phone: 2,
  mail: 3,
};

const escalationReasonToApi: Record<EscalationReason, number> = {
  customer_requested_human: 0,
  urgent_issue: 1,
  pricing_dispute: 2,
  unclear_audio: 3,
  backend_failure: 4,
  complaint: 5,
  other: 6,
};

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();

const getWorkshopInfoSchema = z.object({
  info: z
    .enum(['hours', 'today_hours', 'location', 'services', 'all'])
    .default('all'),
});

const findCustomerByPhoneSchema = z.object({
  phone: text(40),
});

const createCustomerSchema = z.object({
  name: text(120),
  phone: text(40),
  email: z.string().trim().email().max(160).optional(),
  preferredContactMethod: preferredContactSchema.default('phone'),
  notes: optionalText(1000),
});

const findVehicleByRegoSchema = z.object({
  registration: text(24),
});

const createVehicleSchema = z.object({
  customerId: text(80),
  make: text(80),
  model: text(80),
  year: z.coerce
    .number()
    .int()
    .min(1900)
    .max(new Date().getFullYear() + 1)
    .optional(),
  plate: optionalText(20),
  vin: optionalText(17),
  notes: optionalText(1000),
});

const findLatestBookingByPhoneSchema = z.object({
  phone: text(40),
});

const checkBookingAvailabilitySchema = z.object({
  serviceType: serviceTypeSchema.optional(),
  date: optionalText(80),
  preferredTimeOfDay: z.enum(['morning', 'afternoon', 'any']).default('any'),
  customerId: optionalText(80),
  vehicleId: optionalText(80),
  slotStart: optionalText(80),
});

const createBookingSchema = z.object({
  customerId: text(80),
  vehicleId: text(80),
  serviceType: serviceTypeSchema,
  slotStart: text(80),
  slotEnd: optionalText(80),
  issueDescription: optionalText(1000),
});

const createEscalationSchema = z.object({
  callId: optionalText(80),
  reason: escalationReasonSchema.default('other'),
  summary: text(3000),
  phone: optionalText(40),
});

const serviceTypeParameter = {
  type: 'string',
  enum: [...serviceTypeValues],
  description:
    'Service category. Use other only when the requested service does not fit the listed categories.',
};

function cleanObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function normalizeRego(registration: string): string {
  return registration.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function normalizePhone(phone: string): {
  e164: string;
  display: string;
} {
  const result = validateAustralianPhoneNumber(phone);
  if (!result.ok || !result.e164 || !result.display) {
    throw new AppError(
      'INVALID_PHONE_NUMBER',
      result.reason ?? 'Invalid phone number.',
      { phone },
    );
  }

  return {
    e164: result.e164,
    display: result.display,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.code === 'BOOKING_API_NOT_FOUND';
}

@Injectable()
export class GetWorkshopInfoTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<z.infer<typeof getWorkshopInfoSchema>> = {
    name: 'get_workshop_info',
    description:
      'Read live workshop information from the booking API, including hours, today hours, location, and service list.',
    inputSchema: getWorkshopInfoSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        info: {
          type: 'string',
          enum: ['hours', 'today_hours', 'location', 'services', 'all'],
          description: 'Which workshop information to retrieve.',
        },
      },
    },
    execute: async (input) => {
      const result: Record<string, unknown> = {};
      const wants = (value: typeof input.info) =>
        input.info === 'all' || input.info === value;

      if (wants('hours')) {
        result.hours = await this.api.get<unknown>('/workshop/hours');
      }

      if (wants('today_hours')) {
        result.todayHours = await this.api.get<unknown>(
          '/workshop/today-hours',
        );
      }

      if (wants('location')) {
        result.location = await this.api.getWithFallback<unknown>(
          '/workshop/address',
          '/workshop/location',
        );
      }

      if (wants('services')) {
        result.services = await this.api.get<unknown>('/workshop/services');
      }

      return {
        ...result,
        instruction:
          'Use these live workshop details. Keep the caller-facing answer short.',
      };
    },
  };
}

@Injectable()
export class FindCustomerByPhoneTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<
    z.infer<typeof findCustomerByPhoneSchema>
  > = {
    name: 'find_customer_by_phone',
    description:
      'Find an existing customer in the booking API by Australian phone number. Use after the phone number is clearly heard.',
    inputSchema: findCustomerByPhoneSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['phone'],
      properties: {
        phone: {
          type: 'string',
          description:
            'Australian phone number. Only call this after the caller gives a clear complete number.',
        },
      },
    },
    execute: async (input) => {
      const phone = normalizePhone(input.phone);

      try {
        const customer = await this.api.get<unknown>('/customers/search', {
          phone: phone.e164,
        });

        return {
          found: true,
          phone,
          customer,
          instruction:
            'If this is the right customer, continue collecting the booking details.',
        };
      } catch (error) {
        if (isNotFound(error)) {
          return {
            found: false,
            phone,
            instruction:
              'No existing customer was found. Ask for the missing customer details before creating one.',
          };
        }

        throw error;
      }
    },
  };
}

@Injectable()
export class CreateCustomerTool {
  constructor(
    private readonly api: BookingApiClient,
    private readonly memory: MemoryService,
  ) {}

  readonly definition: ToolDefinition<z.infer<typeof createCustomerSchema>> = {
    name: 'create_customer',
    description:
      'Create a customer through the booking API. If email is missing, the tool will not create the customer and will ask for email.',
    inputSchema: createCustomerSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'phone'],
      properties: {
        name: { type: 'string', description: 'Customer full name.' },
        phone: { type: 'string', description: 'Australian phone number.' },
        email: {
          type: 'string',
          description:
            'Customer email. Required by the current booking API before a customer can be created.',
        },
        preferredContactMethod: {
          type: 'string',
          enum: [...preferredContactValues],
          description: 'Preferred contact method.',
        },
        notes: { type: 'string', description: 'Optional customer notes.' },
      },
    },
    execute: async (input, context) => {
      const phone = normalizePhone(input.phone);
      if (!input.email) {
        return {
          customerCreated: false,
          missingFields: ['email'],
          phone,
          instruction:
            'Ask the caller for their email address before creating the customer record.',
        };
      }

      const customer = await this.api.post<unknown>('/customers', {
        name: input.name,
        email: input.email,
        phone: phone.e164,
        preferred_contact_method:
          preferredContactToApi[input.preferredContactMethod],
        notes: input.notes,
      });

      this.memory.rememberFact(
        context.sessionId,
        `Customer record created for ${input.name}, phone ${phone.display}.`,
        'customer',
      );

      return {
        customerCreated: true,
        customer,
        phone,
        instruction:
          'Use the returned customer id for vehicle lookup or booking creation.',
      };
    },
  };
}

@Injectable()
export class FindVehicleByRegoTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<z.infer<typeof findVehicleByRegoSchema>> =
    {
      name: 'find_vehicle_by_rego',
      description:
        'Find a vehicle in the booking API by registration or plate number.',
      inputSchema: findVehicleByRegoSchema,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['registration'],
        properties: {
          registration: {
            type: 'string',
            description: 'Vehicle registration or plate number.',
          },
        },
      },
      execute: async (input) => {
        const rego = normalizeRego(input.registration);

        try {
          const vehicle = await this.api.get<unknown>('/vehicles/search', {
            rego,
          });

          return {
            found: true,
            registration: rego,
            vehicle,
            instruction:
              'If this vehicle belongs to the caller, use its id for booking creation.',
          };
        } catch (error) {
          if (isNotFound(error)) {
            return {
              found: false,
              registration: rego,
              instruction:
                'No vehicle was found for this registration. Ask for make and model before creating a vehicle.',
            };
          }

          throw error;
        }
      },
    };
}

@Injectable()
export class CreateVehicleTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<z.infer<typeof createVehicleSchema>> = {
    name: 'create_vehicle',
    description:
      'Create a vehicle through the booking API after the customer id, make, and model are known.',
    inputSchema: createVehicleSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['customerId', 'make', 'model'],
      properties: {
        customerId: { type: 'string', description: 'Existing customer id.' },
        make: { type: 'string', description: 'Vehicle make.' },
        model: { type: 'string', description: 'Vehicle model.' },
        year: { type: 'number', description: 'Vehicle year.' },
        plate: { type: 'string', description: 'Registration or plate.' },
        vin: { type: 'string', description: 'VIN, if known.' },
        notes: { type: 'string', description: 'Optional vehicle notes.' },
      },
    },
    execute: async (input) => {
      const vehicle = await this.api.post<unknown>(
        '/vehicles',
        cleanObject({
          customer_id: input.customerId,
          make: input.make,
          model: input.model,
          year: input.year,
          plate: input.plate ? normalizeRego(input.plate) : undefined,
          vin: input.vin,
          notes: input.notes,
        }),
      );

      return {
        vehicleCreated: true,
        vehicle,
        instruction: 'Use the returned vehicle id for booking creation.',
      };
    },
  };
}

@Injectable()
export class FindLatestBookingByPhoneTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<
    z.infer<typeof findLatestBookingByPhoneSchema>
  > = {
    name: 'find_latest_booking_by_phone',
    description:
      'Find the latest booking for a caller by Australian phone number.',
    inputSchema: findLatestBookingByPhoneSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['phone'],
      properties: {
        phone: { type: 'string', description: 'Australian phone number.' },
      },
    },
    execute: async (input) => {
      const phone = normalizePhone(input.phone);

      try {
        const booking = await this.api.get<unknown>('/bookings/search', {
          phone: phone.e164,
        });

        return {
          found: true,
          phone,
          booking,
          instruction:
            'Use this when the caller asks about an existing or recent booking.',
        };
      } catch (error) {
        if (isNotFound(error)) {
          return {
            found: false,
            phone,
            instruction:
              'No booking was found for that phone number. Ask whether they want to make a new booking.',
          };
        }

        throw error;
      }
    },
  };
}

@Injectable()
export class CheckBookingAvailabilityTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<
    z.infer<typeof checkBookingAvailabilitySchema>
  > = {
    name: 'check_booking_availability',
    description:
      'Check live available booking slots through the booking API before offering appointment times.',
    inputSchema: checkBookingAvailabilitySchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serviceType: serviceTypeParameter,
        date: {
          type: 'string',
          description: 'Preferred date, such as 2026-04-20.',
        },
        preferredTimeOfDay: {
          type: 'string',
          enum: ['morning', 'afternoon', 'any'],
          description: 'Preferred part of day.',
        },
        customerId: { type: 'string', description: 'Known customer id.' },
        vehicleId: { type: 'string', description: 'Known vehicle id.' },
        slotStart: {
          type: 'string',
          description: 'Specific ISO slot start when checking one slot.',
        },
      },
    },
    execute: async (input) => {
      const availability = await this.api.post<unknown>(
        '/bookings/check-availability',
        cleanObject({
          service_type: input.serviceType
            ? serviceTypeToApi[input.serviceType]
            : undefined,
          service_type_label: input.serviceType,
          date: input.date,
          preferred_time_of_day: input.preferredTimeOfDay,
          customer_id: input.customerId,
          vehicle_id: input.vehicleId,
          slot_start: input.slotStart,
        }),
      );

      return {
        availability,
        instruction:
          'Offer one or two suitable slots. Ask the caller to confirm before creating a booking.',
      };
    },
  };
}

@Injectable()
export class CreateBookingTool {
  constructor(
    private readonly api: BookingApiClient,
    private readonly memory: MemoryService,
  ) {}

  readonly definition: ToolDefinition<z.infer<typeof createBookingSchema>> = {
    name: 'create_booking',
    description:
      'Create a real booking through the booking API after customer, vehicle, service type, and confirmed slot are known.',
    inputSchema: createBookingSchema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['customerId', 'vehicleId', 'serviceType', 'slotStart'],
      properties: {
        customerId: { type: 'string', description: 'Customer id.' },
        vehicleId: { type: 'string', description: 'Vehicle id.' },
        serviceType: serviceTypeParameter,
        slotStart: {
          type: 'string',
          description: 'Confirmed appointment start as an ISO date/time.',
        },
        slotEnd: {
          type: 'string',
          description: 'Appointment end as an ISO date/time, if known.',
        },
        issueDescription: {
          type: 'string',
          description: 'Customer issue or service notes.',
        },
      },
    },
    execute: async (input, context) => {
      const booking = await this.api.post<unknown>(
        '/bookings',
        cleanObject({
          customer_id: input.customerId,
          vehicle_id: input.vehicleId,
          service_type: serviceTypeToApi[input.serviceType],
          issue_description: input.issueDescription,
          slot_start: input.slotStart,
          slot_end: input.slotEnd,
          status: 0,
          source: 0,
        }),
      );

      this.memory.rememberFact(
        context.sessionId,
        `Booking created for customer ${input.customerId}, vehicle ${input.vehicleId}, ${input.serviceType} at ${input.slotStart}.`,
        'booking',
      );

      return {
        bookingCreated: true,
        booking,
        instruction:
          'Confirm the booking briefly using the returned booking details.',
      };
    },
  };
}

@Injectable()
export class CreateEscalationTool {
  constructor(private readonly api: BookingApiClient) {}

  readonly definition: ToolDefinition<z.infer<typeof createEscalationSchema>> =
    {
      name: 'create_escalation',
      description:
        'Create an escalation in the booking API when the caller asks for a human, has an urgent issue, complains, pricing is disputed, audio is unclear, or the backend fails.',
      inputSchema: createEscalationSchema,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: {
          callId: {
            type: 'string',
            description:
              'External call id. If omitted, the current voice session id is used.',
          },
          reason: {
            type: 'string',
            enum: [...escalationReasonValues],
            description: 'Escalation reason.',
          },
          summary: {
            type: 'string',
            description: 'Short summary of the escalation.',
          },
          phone: { type: 'string', description: 'Caller phone number.' },
        },
      },
      execute: async (input, context: ToolExecutionContext) => {
        const phone = input.phone ? normalizePhone(input.phone) : undefined;
        const escalation = await this.api.post<unknown>(
          '/escalations',
          cleanObject({
            call_id: input.callId ?? context.sessionId,
            reason: escalationReasonToApi[input.reason],
            summary: input.summary,
            phone: phone?.e164,
          }),
        );

        return {
          escalationCreated: true,
          escalation,
          instruction:
            'Tell the caller a team member will follow up. Do not invent exact callback times unless the API returned one.',
        };
      },
    };
}
