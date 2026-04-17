import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/types/errors';
import {
  LlmToolDefinition,
  ToolDefinition,
} from '../../common/types/tool.types';
import { CalculateExpressionTool } from './tools/calculate-expression.tool';
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
  ) {
    const definitions = [
      getCurrentTime.definition,
      calculateExpression.definition,
      rememberFact.definition,
      listMemory.definition,
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
