export type ClientEventType =
  | 'session.start'
  | 'text.message'
  | 'session.interrupt'
  | 'session.end';

export type ServerEventType =
  | 'session.started'
  | 'session.ended'
  | 'session.interrupted'
  | 'session.end_requested'
  | 'transcript.final'
  | 'reasoning.started'
  | 'reasoning.first_token'
  | 'assistant.text.chunk'
  | 'assistant.response'
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
  | BaseClientEvent<'text.message', { text: string }>
  | BaseClientEvent<'session.interrupt', { reason?: string }>
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
  | BaseServerEvent<
      'transcript.final',
      { turnId: string; text: string; latencyMs: number }
    >
  | BaseServerEvent<'reasoning.started', { turnId: string }>
  | BaseServerEvent<
      'reasoning.first_token',
      { turnId: string; latencyMs: number; source: 'stream' | 'generate' }
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
      'error',
      {
        code: string;
        message: string;
        details?: unknown;
        recoverable: boolean;
      }
    >;
