import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolRegistryService } from './tool-registry.service';
import { ToolRuntimeService } from './tool-runtime.service';
import { CalculateExpressionTool } from './tools/calculate-expression.tool';
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
  ],
  exports: [ToolRegistryService, ToolRuntimeService],
})
export class ToolsModule {}
