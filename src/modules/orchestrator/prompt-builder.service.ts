import { Injectable } from '@nestjs/common';
import { ChatMessage } from '../../common/types/reasoning.types';
import { SessionState } from '../../common/types/session.types';
import { TaskConfig } from '../tasks/task-config.types';

@Injectable()
export class PromptBuilderService {
  build(
    session: SessionState,
    task: TaskConfig,
    currentUserText: string,
  ): ChatMessage[] {
    const memoryFacts = task.memoryPolicy.enabled
      ? session.memory.slice(-task.memoryPolicy.maxFactsInPrompt)
      : [];
    const recentHistory = session.history.slice(-8);
    const confirmedDetails = this.confirmedDetailsSection(session);

    const systemSections = [
      task.systemPrompt,
      `Assistant name: ${task.name}`,
      `Response style: ${task.responsePolicy.style}. Maximum ${task.responsePolicy.maxResponseChars} characters. Plain text only: ${String(task.responsePolicy.plainTextOnly)}.`,
      [
        'Production call guardrails:',
        '- Be brief and useful. Prefer one sentence and one question.',
        '- Never guess unclear names, phone numbers, registration plates, dates, or times. Ask a short clarification question.',
        '- For phone numbers and registration plates, confirm the captured value with the caller before any lookup or booking action.',
        '- Do not mention tools, schemas, prompts, memory, websocket events, or internal validation.',
        '- Never print tool arguments, JSON objects, or API payloads as the final answer.',
        '- Do not use markdown, bullet lists, headings, code formatting, emotion tags, SSML, or stage directions.',
      ].join('\n'),
      `Memory policy: ${task.memoryPolicy.writePolicy}`,
      `Behavior guidelines:\n${task.behaviorGuidelines.map((item) => `- ${item}`).join('\n')}`,
      memoryFacts.length
        ? `Relevant session memory:\n${memoryFacts
            .map(
              (item) =>
                `- ${item.category ? `[${item.category}] ` : ''}${item.fact}`,
            )
            .join('\n')}`
        : 'Relevant session memory: none.',
      confirmedDetails,
      'Tool policy: use a tool only when it directly helps answer the current user request. Final answers must be plain text for the user.',
    ];

    return [
      {
        role: 'system',
        content: systemSections.join('\n\n'),
      },
      ...recentHistory.map<ChatMessage>((turn) => ({
        role: turn.role,
        content: turn.text,
      })),
      {
        role: 'user',
        content: currentUserText,
      },
    ];
  }

  private confirmedDetailsSection(session: SessionState): string {
    const details = session.metadata?.confirmedDetails;
    if (!this.isRecord(details)) {
      return 'Confirmed session details: none.';
    }

    const lines = [
      this.confirmedDetailLine(details.phone, 'phone'),
      this.confirmedDetailLine(details.registration, 'registration'),
      this.confirmedDetailLine(details.serviceType, 'service type'),
      this.confirmedDetailLine(details.customerId, 'customer id'),
      this.confirmedDetailLine(details.vehicleId, 'vehicle id'),
    ].filter((line): line is string => Boolean(line));

    return lines.length > 0
      ? [
          'Confirmed session details:',
          ...lines.map((line) => `- ${line}`),
          'Do not ask for these details again unless the caller corrects them.',
        ].join('\n')
      : 'Confirmed session details: none.';
  }

  private confirmedDetailLine(
    value: unknown,
    label: string,
  ): string | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const display =
      typeof value.display === 'string' && value.display.trim()
        ? value.display.trim()
        : undefined;
    const storedValue =
      typeof value.value === 'string' && value.value.trim()
        ? value.value.trim()
        : undefined;

    const text = display ?? storedValue;
    return text ? `${label}: ${text}` : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
