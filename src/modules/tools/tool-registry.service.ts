import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/types/errors';
import {
  LlmToolDefinition,
  ToolDefinition,
} from '../../common/types/tool.types';
import {
  CheckBookingAvailabilityTool,
  CreateBookingTool,
  CreateCustomerTool,
  CreateEscalationTool,
  CreateVehicleTool,
  FindCustomerByPhoneTool,
  FindLatestBookingByPhoneTool,
  FindVehicleByRegoTool,
  GetWorkshopInfoTool,
} from './tools/booking-api-tools';
import { CalculateExpressionTool } from './tools/calculate-expression.tool';
import { CaptureCustomerDetailsTool } from './tools/capture-customer-details.tool';
import { CheckServiceAvailabilityTool } from './tools/check-service-availability.tool';
import { CheckServiceHoursTool } from './tools/check-service-hours.tool';
import { CreateServiceBookingTool } from './tools/create-service-booking.tool';
import { GetServiceLocationTool } from './tools/get-service-location.tool';
import { GetServiceTypesTool } from './tools/get-service-types.tool';
import { GetCurrentTimeTool } from './tools/get-current-time.tool';
import { ListMemoryTool } from './tools/list-memory.tool';
import { RememberFactTool } from './tools/remember-fact.tool';

@Injectable()
export class ToolRegistryService {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(
    getCurrentTime: GetCurrentTimeTool,
    calculateExpression: CalculateExpressionTool,
    rememberFact: RememberFactTool,
    listMemory: ListMemoryTool,
    checkServiceHours: CheckServiceHoursTool,
    getServiceLocation: GetServiceLocationTool,
    getServiceTypes: GetServiceTypesTool,
    captureCustomerDetails: CaptureCustomerDetailsTool,
    checkServiceAvailability: CheckServiceAvailabilityTool,
    createServiceBooking: CreateServiceBookingTool,
    getWorkshopInfo: GetWorkshopInfoTool,
    findCustomerByPhone: FindCustomerByPhoneTool,
    createCustomer: CreateCustomerTool,
    findVehicleByRego: FindVehicleByRegoTool,
    createVehicle: CreateVehicleTool,
    findLatestBookingByPhone: FindLatestBookingByPhoneTool,
    checkBookingAvailability: CheckBookingAvailabilityTool,
    createBooking: CreateBookingTool,
    createEscalation: CreateEscalationTool,
  ) {
    const definitions = [
      getCurrentTime.definition,
      calculateExpression.definition,
      rememberFact.definition,
      listMemory.definition,
      checkServiceHours.definition,
      getServiceLocation.definition,
      getServiceTypes.definition,
      captureCustomerDetails.definition,
      checkServiceAvailability.definition,
      createServiceBooking.definition,
      getWorkshopInfo.definition,
      findCustomerByPhone.definition,
      createCustomer.definition,
      findVehicleByRego.definition,
      createVehicle.definition,
      findLatestBookingByPhone.definition,
      checkBookingAvailability.definition,
      createBooking.definition,
      createEscalation.definition,
    ];

    this.tools = new Map(definitions.map((tool) => [tool.name, tool]));
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AppError('TOOL_NOT_FOUND', `Tool ${name} is not registered.`);
    }
    return tool;
  }

  listAllowed(names: string[]): ToolDefinition[] {
    return names.map((name) => this.get(name));
  }

  toLlmTools(names: string[]): LlmToolDefinition[] {
    return this.listAllowed(names).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
