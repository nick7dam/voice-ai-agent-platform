import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TaskRegistryService } from './task-registry.service';

@Module({
  controllers: [TasksController],
  providers: [TaskRegistryService],
  exports: [TaskRegistryService],
})
export class TasksModule {}
