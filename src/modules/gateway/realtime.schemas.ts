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
    type: z.literal('session.end'),
    payload: z.record(z.string(), z.never()).optional(),
  }),
]);

export type ParsedClientEvent = z.infer<typeof clientEventSchema>;
