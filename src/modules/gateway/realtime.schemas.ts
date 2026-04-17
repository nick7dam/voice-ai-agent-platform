import { z } from 'zod';

const eventBase = {
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
};

export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('session.start'),
    payload: z
      .object({
        taskKey: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('audio.chunk'),
    payload: z.object({
      audioBase64: z.string().optional(),
      mimeType: z.string().optional(),
      sampleRate: z.number().int().positive().optional(),
      isFinal: z.boolean().optional(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('audio.stream_start'),
    payload: z
      .object({
        mimeType: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('audio.stream_stop'),
    payload: z.record(z.string(), z.never()).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('audio.turn_end'),
    payload: z.record(z.string(), z.never()).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('text.message'),
    payload: z.object({
      text: z.string().min(1),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('session.interrupt'),
    payload: z
      .object({
        reason: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('session.audio_output'),
    payload: z.object({
      enabled: z.boolean(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('session.end'),
    payload: z.record(z.string(), z.never()).optional(),
  }),
]);

export type ParsedClientEvent = z.infer<typeof clientEventSchema>;
