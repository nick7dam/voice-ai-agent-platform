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
import { elapsedMs, nowIso } from '../../common/utils/timing';
import * as appConfig from '../../config/app.config';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { SessionsService } from '../sessions/sessions.service';
import { SttService } from '../stt/stt.service';
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
  private readonly partialTranscriptions = new Set<string>();
  private httpServer?: HttpServer;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly config: appConfig.AppConfig,
    private readonly sessions: SessionsService,
    private readonly stt: SttService,
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
          // The session may already have been explicitly ended by the client.
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
        this.handleBinaryAudio(client, this.rawDataToBuffer(data));
        return;
      }

      const event = this.parseJsonEvent(data);
      await this.handleJsonEvent(client, event);
    } catch (error) {
      this.emitError(client, undefined, error);
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
      case 'audio.stream_start':
        this.handleAudioStreamStart(client, event);
        return;
      case 'audio.stream_stop':
        this.handleAudioStreamStop(client, event);
        return;
      case 'audio.turn_start':
        this.handleAudioTurnStart(client, event);
        return;
      case 'audio.partial':
        await this.handleAudioPartial(client, event);
        return;
      case 'audio.chunk':
        await this.handleAudioChunk(client, event);
        return;
      case 'audio.turn_end':
        await this.processAudioTurn(
          client,
          this.resolveSessionId(client, event),
        );
        return;
      case 'text.message':
        await this.handleTextMessage(client, event);
        return;
      case 'session.interrupt':
        this.handleSessionInterrupt(client, event);
        return;
      case 'session.audio_output':
        this.handleSessionAudioOutput(client, event);
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

  private async handleAudioChunk(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'audio.chunk' }>,
  ): Promise<void> {
    const sessionId = this.resolveSessionId(client, event);
    const audioBase64 = event.payload.audioBase64;

    if (!audioBase64) {
      throw new AppError(
        'AUDIO_CHUNK_MISSING',
        'audio.chunk requires payload.audioBase64 unless binary frames are used.',
      );
    }

    const chunk = Buffer.from(audioBase64, 'base64');
    const result = this.sessions.appendAudioChunk(sessionId, chunk, {
      mimeType: event.payload.mimeType,
      sampleRate: event.payload.sampleRate,
    });

    this.send(client, {
      type: 'audio.chunk.received',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {
        bytes: chunk.byteLength,
        turnId: result.turnId,
        bufferedBytes: result.bufferedBytes,
      },
    });

    if (event.payload.isFinal) {
      await this.processAudioTurn(client, sessionId);
    }
  }

  private handleAudioStreamStart(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'audio.stream_start' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    this.logger.log(`audio.stream.start session=${sessionId}`);
    this.send(client, {
      type: 'audio.stream.started',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {
        mimeType: event.payload?.mimeType,
      },
    });
  }

  private handleAudioStreamStop(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'audio.stream_stop' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    this.logger.log(`audio.stream.stop session=${sessionId}`);

    this.send(client, {
      type: 'audio.stream.stopped',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {},
    });
  }

  private handleAudioTurnStart(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'audio.turn_start' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    const turnId = this.sessions.beginTurn(sessionId);
    this.sessions.ensureAudioTurn(
      sessionId,
      event.payload?.mimeType,
      event.payload?.sampleRate,
    );

    this.logger.log(`audio.turn.start session=${sessionId} turn=${turnId}`);
  }

  private async handleAudioPartial(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'audio.partial' }>,
  ): Promise<void> {
    const sessionId = this.resolveSessionId(client, event);

    if (!this.config.stt.partialEnabled) {
      return;
    }

    const session = this.sessions.get(sessionId);
    const turnId =
      session.audio.turnId ??
      this.sessions.ensureAudioTurn(
        sessionId,
        event.payload.mimeType,
        event.payload.sampleRate,
      );
    const audio = Buffer.from(event.payload.audioBase64, 'base64');

    if (audio.byteLength < this.config.minSttAudioBytes) {
      return;
    }

    const partialKey = `${sessionId}:${turnId}`;
    if (this.partialTranscriptions.has(partialKey)) {
      return;
    }

    this.partialTranscriptions.add(partialKey);

    try {
      const transcription = await this.stt.transcribeTurn({
        sessionId,
        turnId,
        audio,
        mimeType: event.payload.mimeType ?? session.audio.mimeType,
        sampleRate: event.payload.sampleRate ?? session.audio.sampleRate,
      });

      const current = this.sessions.get(sessionId);
      if (
        current.currentState !== 'listening' ||
        !this.sessions.isCurrentTurn(sessionId, turnId)
      ) {
        return;
      }

      const text = transcription.text.trim();
      if (!text) {
        return;
      }

      this.send(client, {
        type: 'transcript.partial',
        sessionId,
        requestId: event.requestId,
        timestamp: nowIso(),
        payload: {
          turnId,
          text,
          latencyMs: transcription.latencyMs,
          sequence: event.payload.sequence,
        },
      });
    } catch (error) {
      const payload = toErrorPayload(error);
      this.logger.warn(
        `transcript.partial.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message}`,
      );
    } finally {
      this.partialTranscriptions.delete(partialKey);
    }
  }

  private handleBinaryAudio(client: WebSocket, chunk: Buffer): void {
    const sessionId = this.resolveSessionId(client);
    const result = this.sessions.appendAudioChunk(sessionId, chunk);

    this.send(client, {
      type: 'audio.chunk.received',
      sessionId,
      timestamp: nowIso(),
      payload: {
        bytes: chunk.byteLength,
        turnId: result.turnId,
        bufferedBytes: result.bufferedBytes,
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

  private async processAudioTurn(
    client: WebSocket,
    sessionId: string,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();

    try {
      const turn = this.sessions.consumeAudioTurn(sessionId);

      if (turn.audio.byteLength < this.config.minSttAudioBytes) {
        this.sessions.setState(sessionId, 'idle');
        this.send(client, {
          type: 'audio.turn.discarded',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId: turn.turnId,
            reason: 'audio_too_small_for_stt',
            bytes: turn.audio.byteLength,
          },
        });
        this.logger.log(
          `turn.discarded session=${sessionId} turn=${turn.turnId} bytes=${turn.audio.byteLength}`,
        );
        return;
      }

      const transcription = await this.stt.transcribeTurn({
        sessionId,
        turnId: turn.turnId,
        audio: turn.audio,
        mimeType: turn.mimeType,
        sampleRate: turn.sampleRate,
      });

      if (!this.sessions.isCurrentTurn(sessionId, turn.turnId)) {
        this.logger.log(
          `transcript.skip_stale session=${sessionId} turn=${turn.turnId}`,
        );
        return;
      }

      this.send(client, {
        type: 'transcript.final',
        sessionId,
        timestamp: nowIso(),
        payload: {
          turnId: turn.turnId,
          text: transcription.text,
          latencyMs: transcription.latencyMs,
        },
      });

      await this.orchestrator.handleTranscript(
        sessionId,
        turn.turnId,
        transcription.text,
        (serverEvent) => this.send(client, serverEvent),
      );

      this.logger.log(
        `turn.end session=${sessionId} turn=${turn.turnId} latencyMs=${elapsedMs(startedAt)}`,
      );
    } catch (error) {
      this.sessions.setState(sessionId, 'idle');
      this.emitError(client, sessionId, error);
    }
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

  private handleSessionInterrupt(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'session.interrupt' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    this.sessions.interrupt(sessionId);
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

  private handleSessionAudioOutput(
    client: WebSocket,
    event: Extract<ParsedClientEvent, { type: 'session.audio_output' }>,
  ): void {
    const sessionId = this.resolveSessionId(client, event);
    this.sessions.setAudioOutputEnabled(sessionId, event.payload.enabled);
    this.logger.log(
      `session.audio_output session=${sessionId} enabled=${event.payload.enabled}`,
    );

    this.send(client, {
      type: 'session.audio_output.updated',
      sessionId,
      requestId: event.requestId,
      timestamp: nowIso(),
      payload: {
        enabled: event.payload.enabled,
      },
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
        'Start a session before sending audio, text, or control events.',
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
