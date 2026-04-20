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
    const recentHistory = session.history.slice(-8);
    const systemSections = [
      task.systemPrompt,
      `Assistant name: ${task.name}`,
      `Response style: ${task.responsePolicy.style}. Maximum ${task.responsePolicy.maxResponseChars} characters. Plain text only: ${String(task.responsePolicy.plainTextOnly)}.`,
      task.behaviorGuidelines.length
        ? `Behavior guidelines:\n${task.behaviorGuidelines.map((item) => `- ${item}`).join('\n')}`
        : 'Behavior guidelines: none.',
      [
        'Transport contract:',
        '- Return only user-facing plain text.',
        '- Do not use markdown, code blocks, JSON, tool call syntax, SSML, or stage directions.',
        '- Keep responses concise because they are spoken by the voice transport.',
        '- If the conversation is clearly finished, include [[END_CALL]] at the very end.',
      ].join('\n'),
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
}
