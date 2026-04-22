import { Module } from '@nestjs/common';
import { ConversationEngineModule } from '../conversation-engine/conversation-engine.module';
import { ReasoningModule } from '../reasoning/reasoning.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { BookingGraphService } from './booking-graph.service';
import { OrchestratorService } from './orchestrator.service';
import { PromptBuilderService } from './prompt-builder.service';

@Module({
  imports: [
    SessionsModule,
    TasksModule,
    ReasoningModule,
    ConversationEngineModule,
  ],
  providers: [OrchestratorService, PromptBuilderService, BookingGraphService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
