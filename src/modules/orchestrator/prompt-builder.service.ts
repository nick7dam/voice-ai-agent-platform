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

    const systemSections = [
      task.systemPrompt,
      `Assistant name: ${task.name}`,
      `Response style: ${task.responsePolicy.style}. Maximum ${task.responsePolicy.maxResponseChars} characters. Plain text only: ${String(task.responsePolicy.plainTextOnly)}.`,
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
}
