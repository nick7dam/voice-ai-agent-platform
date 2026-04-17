import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ToolDefinition } from '../../../common/types/tool.types';
import { carServiceBusiness } from './car-service-data';

const schema = z.object({
  includeParking: z.boolean().optional(),
});

@Injectable()
export class GetServiceLocationTool {
  readonly definition: ToolDefinition<z.infer<typeof schema>> = {
    name: 'get_service_location',
    description:
      'Get the car service workshop address, contact details, and simple arrival notes.',
    inputSchema: schema,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeParking: {
          type: 'boolean',
          description:
            'Whether to include parking and nearby landmark information.',
        },
      },
    },
    execute: (input) =>
      Promise.resolve({
        businessName: carServiceBusiness.name,
        address: carServiceBusiness.address,
        suburb: carServiceBusiness.suburb,
        state: carServiceBusiness.state,
        phone: carServiceBusiness.phone,
        email: carServiceBusiness.email,
        parkingAndLandmarks: input.includeParking
          ? carServiceBusiness.landmarks
          : undefined,
      }),
  };
}
