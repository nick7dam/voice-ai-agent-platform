import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { AppError } from '../../common/types/errors';
import { TaskRegistryService } from './task-registry.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TaskRegistryService) {}

  @Get()
  listTasks() {
    return {
      defaultTaskKey: this.tasks.getDefaultTask().key,
      storage: this.tasks.getStorageInfo(),
      tasks: this.tasks.list(),
    };
  }

  @Get(':taskKey')
  getTask(@Param('taskKey') taskKey: string) {
    try {
      return {
        task: this.tasks.get(taskKey),
        storage: this.tasks.getStorageInfo(),
      };
    } catch (error) {
      this.throwHttpError(error);
    }
  }

  @Put(':taskKey')
  updateTask(@Param('taskKey') taskKey: string, @Body() body: unknown) {
    try {
      return {
        task: this.tasks.update(taskKey, body),
        storage: this.tasks.getStorageInfo(),
      };
    } catch (error) {
      this.throwHttpError(error);
    }
  }

  @Post(':taskKey/reset')
  resetTask(@Param('taskKey') taskKey: string) {
    try {
      return {
        task: this.tasks.reset(taskKey),
        storage: this.tasks.getStorageInfo(),
      };
    } catch (error) {
      this.throwHttpError(error);
    }
  }

  private throwHttpError(error: unknown): never {
    if (error instanceof ZodError) {
      throw new BadRequestException({
        code: 'TASK_CONFIG_INVALID',
        message: 'Task config is invalid.',
        issues: error.issues,
      });
    }

    if (error instanceof AppError && error.code === 'TASK_NOT_FOUND') {
      throw new NotFoundException({
        code: error.code,
        message: error.message,
      });
    }

    throw error;
  }
}
