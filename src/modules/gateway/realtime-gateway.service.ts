import { HttpAdapterHost } from '@nestjs/core';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { IncomingMessage, Server as HttpServer } from 'node:http';
import { Socket } from 'node:net';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { APP_CONFIG } from '../../common/constants/injection-tokens';
import { AppError, toErrorPayload } from '../../common/types/errors';
import { ServerEvent } from '../../common/types/realtime-events';
import { nowIso } from '../../common/utils/timing';
import * as appConfig from '../../config/app.config';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { clientEventSchema, ParsedClientEvent } from './realtime.schemas';

interface ClientContext {
  sessionId?: string;
}

@Injectable()
export class RealtimeGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGatewayService.name);
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Map<WebSocket, ClientContext>();
  private httpServer?: HttpServer;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly config: appConfig.AppConfig,
    private readonly sessions: SessionsService,
    private readonly orchestrator: OrchestratorService,
    private readonly tasks: TaskRegistryService,
  ) {}

  onModuleInit(): void {
    this.httpServer =
      this.httpAdapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.httpServer.on('upgrade', this.handleUpgrade);
    this.wss.on('connection', (client) => this.handleConnection(client));
    this.logger.log(`websocket.ready path=${this.config.wsPath}`);
  }

  onModuleDestroy(): void {
    this.httpServer?.off('upgrade', this.handleUpgrade);
    this.wss.close();
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (url.pathname !== this.config.wsPath) {
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (client) => {
      this.wss.emit('connection', client, request);
    });
  };

  private handleConnection(client: WebSocket): void {
    this.clients.set(client, {});
    this.logger.log('websocket.connected');

    client.on('message', (data, isBinary) => {
      void this.handleMessage(client, data, isBinary);
    });

    client.on('close', () => {
      const context = this.clients.get(client);
      if (context?.sessionId) {
        try {
          this.sessions.end(context.sessionId);
        } catch {
          // The session may already have been explicitly ended by the gateway.
        }
      }
      this.clients.delete(client);
      this.logger.log('websocket.closed');
    });
  }

  private async handleMessage(
    client: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    try {
      if (isBinary) {
        throw new AppError(
          'BINARY_EVENTS_UNSUPPORTED',
          'Send audio over WebRTC. The Nest websocket only accepts JSON control events.',
        );
      }

      const event = this.parseJsonEvent(data);
      await this.handleJsonEvent(client, event);
    } catch (error) {
      this.emitError(client, this.clients.get(client)?.sessionId, error);
    }
  }

  private async handleJsonEvent(
    client: WebSocket,
    event: ParsedClientEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'session.start':
        this.handleSessionStart(client, event);
        return;
      case 'text.message':
        await this.handleTextMessage(client, event);
        return;
      case 'session.interrupt':
        this.handleSessionInterrupt(client, event);
        return;
      case 'session.end':
        this.handleSessionEnd(client, event);
        return;
    }
  }

  private handleSessionStart(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'session.start' }>,
  ): void {
    const taskKey = event.payload?.taskKey ?? this.tasks.getDefaultTask().key;
    this.tasks.get(taskKey);

    const session = this.sessions.create(taskKey, event.payload?.metadata);
    this.clients.set(client, { sessionId: session.id });

    this.send(client, {
      type: 'session.started',
      sessionId: session.id,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {
        sessionId: session.id,
        taskKey: session.taskKey,
        wsPath: this.config.wsPath,
      },
    });
  }

  private async handleTextMessage(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'text.message' }>,
  ): Promise<void> {
    const sessionId = this.resolveSessionId(client, event);
    const turnId = this.sessions.beginTextTurn(sessionId);
    const text = event.payload.text.trim();

    this.send(client, {
      type: 'transcript.final',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {
        turnId,
        text,
        latencyMs: 0,
      },
    });

    await this.orchestrator.handleTranscript(
      sessionId,
      turnId,
      text,
      (serverEvent) => this.send(client, serverEvent),
    );
  }

  private handleSessionInterrupt(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'session.interrupt' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    this.sessions.interrupt(sessionId, event.payload?.reason);
    this.logger.log(
      `session.interrupt session=${sessionId} reason=${event.payload?.reason ?? 'unspecified'}`,
    );

    this.send(client, {
      type: 'session.interrupted',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {
        reason: event.payload?.reason,
      },
    });
  }

  private handleSessionEnd(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'session.end' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    this.sessions.end(sessionId);
    this.clients.set(client, {});

    this.send(client, {
      type: 'session.ended',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: { sessionId },
    });
  }

  private parseJsonEvent(data: RawData): ParsedClientEvent {
    const text = this.rawDataToBuffer(data).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    const result = clientEventSchema.safeParse(parsed);

    if (!result.success) {
      throw new AppError(
        'INVALID_EVENT',
        'WebSocket event failed validation.',
        result.error.issues.map((issue) => issue.message),
      );
    }

    return result.data;
  }

  private rawDataToBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
      return data;
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data);
    }
    return Buffer.from(data);
  }

  private resolveSessionId(
    client: WebSocket,
    event?: { sessionId?: string },
  ): string {
    const sessionId = event?.sessionId ?? this.clients.get(client)?.sessionId;

    if (!sessionId) {
      throw new AppError(
        'SESSION_REQUIRED',
        'Start a session before sending transcript or control events.',
      );
    }

    return sessionId;
  }

  private send(client: WebSocket, event: ServerEvent): void {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }
    client.send(JSON.stringify(event));
  }

  private emitError(
    client: WebSocket,
    sessionId: string | undefined,
    error: unknown,
  ): void {
    const payload = toErrorPayload(error);
    this.send(client, {
      type: 'error',
      sessionId,
      timestamp: nowIso(),
      payload,
    });
    this.logger.warn(
      `websocket.error code=${payload.code} message=${payload.message}`,
    );
  }
}
