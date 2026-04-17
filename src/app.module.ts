import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { HealthModule } from './modules/health/health.module';
import { MemoryModule } from './modules/memory/memory.module';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module';
import { ReasoningModule } from './modules/reasoning/reasoning.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SttModule } from './modules/stt/stt.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { ToolsModule } from './modules/tools/tools.module';
import { TtsModule } from './modules/tts/tts.module';

@Module({
  imports: [
    ConfigModule,
    SessionsModule,
    MemoryModule,
    TasksModule,
    ToolsModule,
    TtsModule,
    SttModule,
    ReasoningModule,
    OrchestratorModule,
    GatewayModule,
    HealthModule,
  ],
})
export class AppModule {}
