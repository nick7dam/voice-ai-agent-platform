import { SessionState } from '../../common/types/session.types';
import { TaskConfig } from '../tasks/task-config.types';
import { PromptBuilderService } from './prompt-builder.service';

describe('PromptBuilderService', () => {
  it('includes interruption context so the next turn can continue naturally', () => {
    const builder = new PromptBuilderService();
    const session: SessionState = {
      id: 'session-1',
      taskKey: 'general_voice_assistant',
      history: [],
      recentAssistantResponses: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentState: 'idle',
      turnSequence: 1,
      interruptedTurnIds: ['turn-1'],
      interruptedAssistantTurn: {
        turnId: 'turn-1',
        text: 'We are open tomorrow afternoon. Can I help with a booking?',
        reason: 'barge_in',
        at: new Date().toISOString(),
        finalized: true,
      },
    };
    const task: TaskConfig = {
      key: 'general_voice_assistant',
      name: 'General Voice Assistant',
      systemPrompt: 'Help the caller.',
      behaviorGuidelines: [],
      allowedTools: [],
      responsePolicy: {
        style: 'plain spoken text',
        responseLengthMode: 'short',
        hardMaxResponseChars: 360,
        plainTextOnly: true,
      },
      memoryPolicy: {
        enabled: false,
        maxFactsInPrompt: 0,
        writePolicy: 'disabled',
      },
    };

    const messages = builder.build(
      session,
      task,
      'Yes, I need an oil change instead.',
    );

    expect(messages[0]?.content).toContain(
      'The user interrupted the assistant mid-response.',
    );
    expect(messages[0]?.content).toContain(
      'Continue naturally from the interrupted topic instead of restarting from scratch.',
    );
    expect(messages[0]?.content).toContain(
      'We are open tomorrow afternoon. Can I help with a booking?',
    );
  });
});
