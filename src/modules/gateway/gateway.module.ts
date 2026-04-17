import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SttModule } from '../stt/stt.module';
import { TasksModule } from '../tasks/tasks.module';
import { RealtimeGatewayService } from './realtime-gateway.service';

@Module({
  imports: [SessionsModule, SttModule, OrchestratorModule, TasksModule],
  providers: [RealtimeGatewayService],
})
export class GatewayModule {}
