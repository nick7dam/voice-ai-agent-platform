import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ToolDefinition } from '../../../common/types/tool.types';
import {
  carServiceBusiness,
  serviceCatalog,
  serviceTypes,
} from './car-service-data';

const schema = z.object({
  serviceType: z.string().max(120).optional(),
});

@Injectable()
export class GetServiceTypesTool {
  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'get_service_types',
    description:
      'List supported car service types and the key intake question for a requested service.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serviceType: {
          type: 'string',
          description:
            'Optional requested service, such as logbook service, oil change, brakes, or diagnostic check.',
        },
      },
    },
    execute: (input) => {
      const requested = input.serviceType?.toLowerCase();
      const matchedService = requested
        ? serviceCatalog.find((service) => {
            const name = service.name.toLowerCase();
            return (
              requested.includes(name) ||
              name.includes(requested) ||
              requested
                .split(/\s+/)
                .some((word) => word.length > 3 && name.includes(word))
            );
          })
        : undefined;

      return Promise.resolve({
        businessName: carServiceBusiness.name,
        supportedServices: serviceTypes,
        serviceCatalog,
        requestedService: matchedService ?? null,
        note: 'For unclear symptoms, offer a diagnostic check or inspection rather than guessing the repair.',
      });
    },
  };
}
