import { Module } from '@nestjs/common';
import { ToolsModule } from '../tools/tools.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ToolsModule],
  controllers: [HealthController],
})
export class HealthModule {}
