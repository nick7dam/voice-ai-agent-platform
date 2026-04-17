import { Module } from '@nestjs/common';
import { ReasoningModule } from '../reasoning/reasoning.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { ToolsModule } from '../tools/tools.module';
import { TtsModule } from '../tts/tts.module';
import { OrchestratorService } from './orchestrator.service';
import { PromptBuilderService } from './prompt-builder.service';

@Module({
  imports: [
    SessionsModule,
    TasksModule,
    ReasoningModule,
    ToolsModule,
    TtsModule,
  ],
  providers: [OrchestratorService, PromptBuilderService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
