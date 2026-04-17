import { z } from 'zod';

export const taskConfigSchema = z
  .object({
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    systemPrompt: z.string().trim().min(1),
    behaviorGuidelines: z.array(z.string().trim().min(1)).default([]),
    allowedTools: z.array(z.string().trim().min(1)).default([]),
    responsePolicy: z.object({
      style: z.string().trim().min(1),
      maxResponseChars: z.coerce.number().int().positive().max(4000),
      plainTextOnly: z.boolean().default(true),
    }),
    memoryPolicy: z.object({
      enabled: z.boolean().default(true),
      maxFactsInPrompt: z.coerce.number().int().min(0).max(50),
      writePolicy: z.string().trim().min(1),
    }),
  })
  .strict();

export const taskConfigFileSchema = z.union([
  z.array(taskConfigSchema),
  z.object({
    updatedAt: z.string().optional(),
    tasks: z.array(taskConfigSchema),
  }),
]);
