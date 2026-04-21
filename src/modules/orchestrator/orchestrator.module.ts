import { Module } from '@nestjs/common';
import { ConversationEngineModule } from '../conversation-engine/conversation-engine.module';
import { ReasoningModule } from '../reasoning/reasoning.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { OrchestratorService } from './orchestrator.service';
import { PromptBuilderService } from './prompt-builder.service';

@Module({
  imports: [
    SessionsModule,
    TasksModule,
    ReasoningModule,
    ConversationEngineModule,
  ],
  providers: [OrchestratorService, PromptBuilderService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
