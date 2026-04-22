import { Injectable } from '@nestjs/common';
import { DialogueDecision } from '../../common/types/conversation.types';
import { ChatMessage } from '../../common/types/reasoning.types';
import { SessionState } from '../../common/types/session.types';
import { TaskConfig } from '../tasks/task-config.types';

@Injectable()
export class PromptBuilderService {
  build(
    session: SessionState,
    task: TaskConfig,
    currentUserText: string,
    options?: {
      decision?: DialogueDecision | null;
    },
  ): ChatMessage[] {
    const recentHistory = session.history.slice(-8);
    const systemSections = [
      task.systemPrompt,
      `Assistant name: ${task.name}`,
      session.interruptedAssistantTurn
        ? this.describeInterruptedAssistantTurn(session)
        : 'Interruption context: none.',
      [
        `Response style: ${task.responsePolicy.style}.`,
        `Length: ${this.describeResponseLength(task)}.`,
        `Plain text only: ${String(task.responsePolicy.plainTextOnly)}.`,
      ].join(' '),
      task.behaviorGuidelines.length
        ? `Behavior guidelines:\n${task.behaviorGuidelines.map((item) => `- ${item}`).join('\n')}`
        : 'Behavior guidelines: none.',
      [
        'Transport contract:',
        '- Return only user-facing plain text.',
        '- Do not use markdown, code blocks, JSON, tool call syntax, SSML, or stage directions.',
        '- Keep responses easy to follow because they are spoken by the voice transport.',
        '- Prefer concise replies unless the task or the user clearly asks for more detail.',
        '- If the conversation is clearly finished, include [[END_CALL]] at the very end.',
      ].join('\n'),
      this.describeConversationState(session, options?.decision),
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

  private describeResponseLength(task: TaskConfig): string {
    const modeDescriptions: Record<
      TaskConfig['responsePolicy']['responseLengthMode'],
      string
    > = {
      short: 'keep replies short by default',
      medium: 'keep replies moderately detailed',
      long: 'allow detailed multi-paragraph replies when helpful',
      unlimited: 'allow long-form replies when the user asks for them',
    };

    const description = modeDescriptions[task.responsePolicy.responseLengthMode];
    const hardMax = task.responsePolicy.hardMaxResponseChars;

    if (hardMax === null) {
      return description;
    }

    return `${description}; stay within ${hardMax} characters unless quoting or listing structured details is essential`;
  }

  private describeInterruptedAssistantTurn(session: SessionState): string {
    const interrupted = session.interruptedAssistantTurn;
    if (!interrupted) {
      return 'Interruption context: none.';
    }

    const completion = interrupted.finalized
      ? 'The assistant had already drafted a full reply, but the user may have heard only part of it.'
      : 'The assistant was interrupted before finishing the reply.';

    return [
      'Interruption context:',
      '- The user interrupted the assistant mid-response.',
      `- ${completion}`,
      '- Treat the next user message as a likely clarification, correction, answer, or redirect of that interrupted reply.',
      '- Continue naturally from the interrupted topic instead of restarting from scratch.',
      `- Interrupted assistant reply: "${interrupted.text}"`,
    ].join('\n');
  }

  private describeConversationState(
    session: SessionState,
    decision?: DialogueDecision | null,
  ): string {
    const liveIntent = session.conversation?.liveIntent;
    if (!liveIntent) {
      return 'Conversation state: none.';
    }

    const slotLines = Object.values(liveIntent.slots).map((slot) => {
      const value = slot.value ? `"${slot.value}"` : 'missing';
      return `- ${slot.label}: ${value} [${slot.status}]`;
    });

    const sections = [
      'Conversation state:',
      `- Profile: ${liveIntent.profileKey}`,
      `- Intent: ${liveIntent.intent.name ?? 'unknown'} [${liveIntent.intent.status}]`,
      `- Floor: ${liveIntent.floor.state} (stability ${liveIntent.floor.stability.toFixed(2)})`,
      `- Latest committed user thought: ${liveIntent.latestCommittedThought ? `"${liveIntent.latestCommittedThought}"` : 'none'}`,
      `- Pending thought: ${liveIntent.pendingThought.text ? `"${liveIntent.pendingThought.text}"` : 'none'} [${liveIntent.pendingThought.status}]`,
      slotLines.length ? `Slots:\n${slotLines.join('\n')}` : 'Slots: none.',
      decision
        ? [
            'Dialogue policy:',
            `- Action: ${decision.action}`,
            `- Reason: ${decision.reason}`,
            decision.slotKey ? `- Focus slot: ${decision.slotKey}` : null,
            liveIntent.prompt.slotKey && liveIntent.prompt.action
              ? `- Prompt focus: ${liveIntent.prompt.slotKey} [${liveIntent.prompt.action}]`
              : null,
            decision.responseText
              ? `- Suggested prompt: "${decision.responseText}"`
              : null,
            `- Use reasoning: ${String(Boolean(decision.shouldReason))}`,
          ]
            .filter(Boolean)
            .join('\n')
        : 'Dialogue policy: none.',
      [
        'State usage rules:',
        '- Treat confirmed slot values as the source of truth unless the user corrects them.',
        '- Do not ask again for details that are already confirmed unless the user changes them.',
        '- If the live intent already contains enough booking context, continue from that context instead of restarting the intake.',
        '- If the dialogue policy action is ask, ask only for the focus slot and keep it brief.',
        '- If the dialogue policy action is confirm, confirm or recapture only the focus slot using the current slot value and the latest user correction.',
        '- If the dialogue policy action is act, continue naturally from the collected state instead of falling back to a stock intake prompt.',
      ].join('\n'),
    ];

    return sections.join('\n');
  }
}
