import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError } from '../../common/types/errors';
import type { AppConfig } from '../../config/app.config';
import { defaultTasks } from './default-tasks';
import { taskConfigFileSchema, taskConfigSchema } from './task-config.schema';
import { TaskConfig } from './task-config.types';

@Injectable()
export class TaskRegistryService {
  private readonly logger = new Logger(TaskRegistryService.name);
  private readonly tasks = new Map<string, TaskConfig>();
  private readonly builtInTasks = new Map<string, TaskConfig>();
  private readonly storagePath: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.storagePath = isAbsolute(this.config.taskConfigPath)
      ? this.config.taskConfigPath
      : resolve(process.cwd(), this.config.taskConfigPath);

    for (const task of defaultTasks) {
      const parsed = taskConfigSchema.parse(task);
      this.builtInTasks.set(parsed.key, this.cloneTask(parsed));
      this.tasks.set(parsed.key, this.cloneTask(parsed));
    }

    this.loadLocalTasks();

    if (!this.tasks.has(this.config.defaultTaskKey)) {
      this.logger.warn(
        `DEFAULT_TASK_KEY=${this.config.defaultTaskKey} is not registered; falling back to general_voice_assistant.`,
      );
    }
  }

  getDefaultTask(): TaskConfig {
    return this.get(this.config.defaultTaskKey, true);
  }

  get(taskKey: string, allowFallback = false): TaskConfig {
    const task = this.tasks.get(taskKey);
    if (task) {
      return this.cloneTask(task);
    }

    if (allowFallback) {
      const fallback = this.tasks.get('general_voice_assistant');
      if (fallback) {
        return this.cloneTask(fallback);
      }
    }

    throw new AppError('TASK_NOT_FOUND', `Task ${taskKey} is not registered.`);
  }

  list(): TaskConfig[] {
    return [...this.tasks.values()].map((task) => this.cloneTask(task));
  }

  update(taskKey: string, input: unknown): TaskConfig {
    if (!this.tasks.has(taskKey)) {
      throw new AppError(
        'TASK_NOT_FOUND',
        `Task ${taskKey} is not registered.`,
      );
    }

    const parsed = taskConfigSchema.parse({
      ...(typeof input === 'object' && input !== null ? input : {}),
      key: taskKey,
    });

    this.tasks.set(taskKey, this.cloneTask(parsed));
    this.persistLocalTasks();
    this.logger.log(`task.update ${taskKey}`);
    return this.cloneTask(parsed);
  }

  reset(taskKey: string): TaskConfig {
    const builtIn = this.builtInTasks.get(taskKey);
    if (!builtIn) {
      throw new AppError(
        'TASK_NOT_FOUND',
        `Task ${taskKey} cannot be reset because it is not a built-in task.`,
      );
    }

    const task = this.cloneTask(builtIn);
    this.tasks.set(taskKey, task);
    this.persistLocalTasks();
    this.logger.log(`task.reset ${taskKey}`);
    return this.cloneTask(task);
  }

  getStorageInfo() {
    return {
      path: this.storagePath,
      exists: existsSync(this.storagePath),
    };
  }

  private loadLocalTasks(): void {
    if (!existsSync(this.storagePath)) {
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown;
      const parsed = taskConfigFileSchema.parse(raw);
      const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;

      for (const task of tasks) {
        this.tasks.set(task.key, this.cloneTask(task));
      }

      this.logger.log(
        `task.local_config.loaded path=${this.storagePath} count=${tasks.length}`,
      );
    } catch (error) {
      this.logger.error(
        `task.local_config.invalid path=${this.storagePath} message=${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private persistLocalTasks(): void {
    mkdirSync(dirname(this.storagePath), { recursive: true });
    writeFileSync(
      this.storagePath,
      `${JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          tasks: this.list(),
        },
        null,
        2,
      )}\n`,
    );
  }

  private cloneTask(task: TaskConfig): TaskConfig {
    return {
      ...task,
      behaviorGuidelines: [...task.behaviorGuidelines],
      allowedTools: [...task.allowedTools],
      responsePolicy: { ...task.responsePolicy },
      memoryPolicy: { ...task.memoryPolicy },
    };
  }
}
