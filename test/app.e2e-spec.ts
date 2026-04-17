import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

interface HealthResponse {
  status: string;
  ollama: unknown;
  groq: unknown;
}

interface TaskPayload {
  key: string;
  name: string;
  systemPrompt: string;
  behaviorGuidelines: string[];
  allowedTools: string[];
  responsePolicy: {
    style: string;
    maxResponseChars: number;
    plainTextOnly: boolean;
  };
  memoryPolicy: {
    enabled: boolean;
    maxFactsInPrompt: number;
    writePolicy: string;
  };
}

interface TaskResponse {
  task: TaskPayload;
}

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'voice-agent-test-'));
    process.env.TASK_CONFIG_PATH = join(tempDir, 'tasks.local.json');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((response) => {
        const body = response.body as HealthResponse;
        expect(body.status).toBe('ok');
        expect(body.ollama).toBeDefined();
        expect(body.groq).toBeDefined();
      });
  });

  it('/tasks/general_voice_assistant (GET, PUT)', async () => {
    const initial = await request(app.getHttpServer())
      .get('/tasks/general_voice_assistant')
      .expect(200);

    const initialBody = initial.body as TaskResponse;
    const task = initialBody.task;

    await request(app.getHttpServer())
      .put('/tasks/general_voice_assistant')
      .send({
        ...task,
        systemPrompt: 'You are a local test assistant.',
        responsePolicy: {
          ...task.responsePolicy,
          maxResponseChars: 120,
        },
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as TaskResponse;
        expect(body.task.systemPrompt).toBe('You are a local test assistant.');
        expect(body.task.responsePolicy.maxResponseChars).toBe(120);
      });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.TASK_CONFIG_PATH;
  });
});
