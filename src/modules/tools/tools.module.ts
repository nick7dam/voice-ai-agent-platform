import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolRegistryService } from './tool-registry.service';
import { ToolRuntimeService } from './tool-runtime.service';
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

@Module({
  imports: [MemoryModule],
  providers: [
    ToolRegistryService,
    ToolRuntimeService,
    GetCurrentTimeTool,
    CalculateExpressionTool,
    RememberFactTool,
    ListMemoryTool,
    CheckServiceHoursTool,
    GetServiceLocationTool,
    GetServiceTypesTool,
    CaptureCustomerDetailsTool,
    CheckServiceAvailabilityTool,
    CreateServiceBookingTool,
  ],
  exports: [ToolRegistryService, ToolRuntimeService],
})
export class ToolsModule {}
