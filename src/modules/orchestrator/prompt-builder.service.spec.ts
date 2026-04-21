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

  it('includes live receptionist state so reasoning can continue from collected booking details', () => {
    const builder = new PromptBuilderService();
    const session: SessionState = {
      id: 'session-2',
      taskKey: 'car_booking_receptionist',
      history: [],
      recentAssistantResponses: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentState: 'idle',
      turnSequence: 2,
      interruptedTurnIds: [],
      conversation: {
        transcriptFragments: [],
        liveIntent: {
          profileKey: 'car_booking_receptionist',
          version: 3,
          intent: {
            name: 'service_booking',
            confidence: 0.9,
            status: 'usable',
            updatedAt: new Date().toISOString(),
          },
          slots: {
            serviceType: {
              key: 'serviceType',
              label: 'service type',
              value: 'oil change',
              canonicalValue: 'oil_change',
              confidence: 0.92,
              status: 'confirmed',
              updatedAt: new Date().toISOString(),
              sourceFragmentIds: ['fragment-1'],
            },
            vehicleRegistration: {
              key: 'vehicleRegistration',
              label: 'vehicle registration',
              value: 'ABC123',
              canonicalValue: 'ABC123',
              confidence: 0.9,
              status: 'confirmed',
              updatedAt: new Date().toISOString(),
              sourceFragmentIds: ['fragment-1'],
            },
          },
          floor: {
            state: 'assistant_waiting',
            stability: 1,
            lastUserActivityAt: new Date().toISOString(),
          },
          pendingThought: {
            fragmentIds: [],
            text: '',
            startedAt: null,
            updatedAt: null,
            status: 'idle',
            incompleteReason: null,
            holdUntil: null,
          },
          latestCommittedThought: 'I need an oil change for rego ABC123.',
        },
      },
    };
    const task: TaskConfig = {
      key: 'car_booking_receptionist',
      name: 'Car Booking Receptionist',
      systemPrompt: 'Help the caller book a service.',
      behaviorGuidelines: [],
      allowedTools: [],
      responsePolicy: {
        style: 'plain spoken text',
        responseLengthMode: 'short',
        hardMaxResponseChars: 320,
        plainTextOnly: true,
      },
      memoryPolicy: {
        enabled: false,
        maxFactsInPrompt: 0,
        writePolicy: 'disabled',
      },
    };

    const messages = builder.build(session, task, 'Next Friday works best.', {
      decision: {
        action: 'act',
        reason: 'minimum_booking_context_ready',
        committedUserText: 'Next Friday works best.',
        shouldReason: true,
      },
    });

    expect(messages[0]?.content).toContain(
      'Profile: car_booking_receptionist',
    );
    expect(messages[0]?.content).toContain(
      'service type: "oil change" [confirmed]',
    );
    expect(messages[0]?.content).toContain(
      'vehicle registration: "ABC123" [confirmed]',
    );
    expect(messages[0]?.content).toContain('Action: act');
  });
});
