import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { HealthModule } from './modules/health/health.module';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module';
import { ReasoningModule } from './modules/reasoning/reasoning.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { TasksModule } from './modules/tasks/tasks.module';

@Module({
  imports: [
    ConfigModule,
    SessionsModule,
    TasksModule,
    ReasoningModule,
    OrchestratorModule,
    GatewayModule,
    HealthModule,
  ],
})
export class AppModule {}
