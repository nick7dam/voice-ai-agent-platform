import { NormalizedToolResult, ToolCall } from './tool.types';

export type ClientEventType =
  | 'session.start'
  | 'audio.stream_start'
  | 'audio.stream_stop'
  | 'audio.turn_start'
  | 'audio.partial'
  | 'audio.chunk'
  | 'audio.turn_end'
  | 'text.message'
  | 'session.interrupt'
  | 'session.audio_output'
  | 'session.end';

export type ServerEventType =
  | 'session.started'
  | 'session.ended'
  | 'session.interrupted'
  | 'session.end_requested'
  | 'session.audio_output.updated'
  | 'audio.stream.started'
  | 'audio.stream.stopped'
  | 'audio.chunk.received'
  | 'audio.turn.discarded'
  | 'transcript.partial'
  | 'transcript.final'
  | 'reasoning.started'
  | 'reasoning.first_token'
  | 'tool.called'
  | 'tool.result'
  | 'assistant.text.chunk'
  | 'assistant.response'
  | 'assistant.audio.started'
  | 'assistant.audio.chunk'
  | 'assistant.audio.ended'
  | 'error';

export interface BaseClientEvent<TType extends ClientEventType, TPayload> {
  type: TType;
  sessionId?: string;
  requestId?: string;
  payload?: TPayload;
}

export type ClientEvent =
  | BaseClientEvent<
      'session.start',
      { taskKey?: string; metadata?: Record<string, unknown> }
    >
  | BaseClientEvent<'audio.stream_start', { mimeType?: string }>
  | BaseClientEvent<'audio.stream_stop', Record<string, never>>
  | BaseClientEvent<
      'audio.turn_start',
      { mimeType?: string; sampleRate?: number }
    >
  | BaseClientEvent<
      'audio.partial',
      {
        audioBase64: string;
        mimeType?: string;
        sampleRate?: number;
        sequence: number;
      }
    >
  | BaseClientEvent<
      'audio.chunk',
      {
        audioBase64?: string;
        mimeType?: string;
        sampleRate?: number;
        isFinal?: boolean;
      }
    >
  | BaseClientEvent<'audio.turn_end', Record<string, never>>
  | BaseClientEvent<'text.message', { text: string }>
  | BaseClientEvent<'session.interrupt', { reason?: string }>
  | BaseClientEvent<'session.audio_output', { enabled: boolean }>
  | BaseClientEvent<'session.end', Record<string, never>>;

export interface BaseServerEvent<TType extends ServerEventType, TPayload> {
  type: TType;
  sessionId?: string;
  requestId?: string;
  timestamp: string;
  payload: TPayload;
}

export type ServerEvent =
  | BaseServerEvent<
      'session.started',
      { sessionId: string; taskKey: string; wsPath: string }
    >
  | BaseServerEvent<'session.ended', { sessionId: string }>
  | BaseServerEvent<'session.interrupted', { reason?: string }>
  | BaseServerEvent<'session.end_requested', { turnId: string; reason: string }>
  | BaseServerEvent<'session.audio_output.updated', { enabled: boolean }>
  | BaseServerEvent<'audio.stream.started', { mimeType?: string }>
  | BaseServerEvent<'audio.stream.stopped', Record<string, never>>
  | BaseServerEvent<
      'audio.turn.discarded',
      { turnId: string; reason: string; bytes: number }
    >
  | BaseServerEvent<
      'audio.chunk.received',
      { bytes: number; turnId: string; bufferedBytes: number }
    >
  | BaseServerEvent<
      'transcript.partial',
      { turnId: string; text: string; latencyMs: number; sequence: number }
    >
  | BaseServerEvent<
      'transcript.final',
      { turnId: string; text: string; latencyMs: number }
    >
  | BaseServerEvent<'reasoning.started', { turnId: string }>
  | BaseServerEvent<
      'reasoning.first_token',
      { turnId: string; latencyMs: number; source: 'stream' | 'generate' }
    >
  | BaseServerEvent<'tool.called', { turnId: string; toolCall: ToolCall }>
  | BaseServerEvent<
      'tool.result',
      { turnId: string; result: NormalizedToolResult }
    >
  | BaseServerEvent<
      'assistant.text.chunk',
      { turnId: string; text: string; index: number; final: boolean }
    >
  | BaseServerEvent<
      'assistant.response',
      { turnId: string; text: string; latencyMs: number }
    >
  | BaseServerEvent<
      'assistant.audio.started',
      {
        turnId: string;
        model: string;
        voice: string;
        format: string;
        segmentCount: number;
        streaming?: boolean;
        sampleRate?: number;
        encoding?: string;
      }
    >
  | BaseServerEvent<
      'assistant.audio.chunk',
      {
        turnId: string;
        index: number;
        total: number;
        audioBase64: string;
        mimeType: string;
        latencyMs: number;
        streaming?: boolean;
        sampleRate?: number;
        encoding?: string;
        chunkIndex?: number;
      }
    >
  | BaseServerEvent<
      'assistant.audio.ended',
      { turnId: string; segmentCount: number }
    >
  | BaseServerEvent<
      'error',
      {
        code: string;
        message: string;
        details?: unknown;
        recoverable: boolean;
      }
    >;
