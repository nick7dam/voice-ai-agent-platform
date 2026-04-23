import type { AppConfig } from '../../config/app.config';
import { SessionsService } from '../sessions/sessions.service';
import { ConversationProfileRegistryService } from '../conversation-engine/conversation-profile.registry';
import { ReasoningService } from '../reasoning/reasoning.service';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { BookingGraphService } from './booking-graph.service';

class FakeReasoningService {
  private readonly replies: string[] = [];

  enqueue(...values: string[]) {
    this.replies.push(...values);
  }

  async generate() {
    const next = this.replies.shift();
    if (next === undefined) {
      throw new Error('No fake reasoning response queued.');
    }

    return {
      text: next,
      model: 'fake',
      latencyMs: 1,
    };
  }
}

describe('BookingGraphService', () => {
  const config = {
    defaultTaskKey: 'car_booking_receptionist',
    taskConfigPath: 'tmp/tasks.json',
  } as AppConfig;

  function createService() {
    const sessions = new SessionsService(config);
    const tasks = new TaskRegistryService(config);
    const profiles = new ConversationProfileRegistryService();
    const reasoning = new FakeReasoningService();
    const service = new BookingGraphService(
      reasoning as unknown as ReasoningService,
      profiles,
    );

    return {
      sessions,
      tasks,
      reasoning,
      service,
    };
  }

  it('moves from rego confirmation to the next missing slot when the caller confirms', async () => {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      JSON.stringify({
        userMove: 'provide_info',
        requestedSlotKey: null,
        slotUpdates: [
          { slotKey: 'serviceType', value: 'oil change', confidence: 0.92 },
        ],
        wantsEndCall: false,
        notes: '',
      }),
      'What is the vehicle registration?',
    );

    const first = await service.processTurn(
      session,
      task,
      'turn-1',
      'I need an oil change.',
    );
    expect(first.decision.action).toBe('ask');
    expect(first.decision.slotKey).toBe('vehicleRegistration');

    sessions.appendHistory(session.id, {
      role: 'user',
      text: 'I need an oil change.',
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: first.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });

    reasoning.enqueue(
      JSON.stringify({
        userMove: 'provide_info',
        requestedSlotKey: null,
        slotUpdates: [
          {
            slotKey: 'vehicleRegistration',
            value: '4ZX2BX',
            confidence: 0.88,
          },
        ],
        wantsEndCall: false,
        notes: '',
      }),
      'I have the vehicle registration as 4 Z X 2 B X. Is that right?',
    );

    const second = await service.processTurn(
      session,
      task,
      'turn-2',
      '4 Z X 2 B X.',
    );
    expect(second.decision.action).toBe('confirm');
    expect(second.decision.slotKey).toBe('vehicleRegistration');
    expect(second.state.slots.vehicleRegistration.value).toBe('4ZX2BX');

    sessions.appendHistory(session.id, {
      role: 'user',
      text: '4 Z X 2 B X.',
      at: new Date().toISOString(),
      turnId: 'turn-2',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: second.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-2',
    });

    reasoning.enqueue(
      'Can I get your name for the booking?',
    );

    const third = await service.processTurn(
      session,
      task,
      'turn-3',
      "Yes, that's correct.",
    );

    expect(third.decision.action).toBe('ask');
    expect(third.decision.slotKey).toBe('customerName');
    expect(third.state.slots.vehicleRegistration.status).toBe('confirmed');
    expect(third.state.slots.vehicleRegistration.needsConfirmation).toBe(
      false,
    );
  });

  it('falls back to heuristic service type capture when structured extraction is unusable', async () => {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      'not valid json at all',
      'What is the vehicle registration?',
    );

    const result = await service.processTurn(
      session,
      task,
      'turn-1',
      'Oil change.',
    );

    expect(result.state.slots.serviceType.value).toBe('oil change');
    expect(result.state.slots.serviceType.status).toBe('confirmed');
    expect(result.decision.action).toBe('ask');
    expect(result.decision.slotKey).toBe('vehicleRegistration');
  });

  it('parses mixed spoken vehicle registration phrases when structured extraction is unusable', async () => {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      'not valid json at all',
      'What is the vehicle registration?',
    );

    const first = await service.processTurn(
      session,
      task,
      'turn-1',
      'Oil change.',
    );

    sessions.appendHistory(session.id, {
      role: 'user',
      text: 'Oil change.',
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: first.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });

    reasoning.enqueue(
      'not valid json at all',
      'I have the vehicle registration as 4 Z X 2 B X. Is that right?',
    );

    const second = await service.processTurn(
      session,
      task,
      'turn-2',
      'Four Z X Two bx.',
    );

    expect(second.state.slots.vehicleRegistration.value).toBe('4ZX2BX');
    expect(second.state.slots.vehicleRegistration.status).toBe('provisional');
    expect(second.decision.action).toBe('confirm');
    expect(second.decision.slotKey).toBe('vehicleRegistration');
  });

  it('merges short follow-up registration fragments onto a provisional registration', async () => {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      'not valid json at all',
      'What is the vehicle registration?',
    );

    const first = await service.processTurn(
      session,
      task,
      'turn-1',
      'Oil change.',
    );

    sessions.appendHistory(session.id, {
      role: 'user',
      text: 'Oil change.',
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: first.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });

    reasoning.enqueue(
      'not valid json at all',
      'I have the vehicle registration as 4 Z X. Is that right?',
    );

    const second = await service.processTurn(
      session,
      task,
      'turn-2',
      'Four Z X.',
    );

    sessions.appendHistory(session.id, {
      role: 'user',
      text: 'Four Z X.',
      at: new Date().toISOString(),
      turnId: 'turn-2',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: second.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-2',
    });

    reasoning.enqueue(
      'not valid json at all',
      'I have the vehicle registration as 4 Z X 2 B X. Is that right?',
    );

    const third = await service.processTurn(
      session,
      task,
      'turn-3',
      'X two bx.',
    );

    expect(third.state.slots.vehicleRegistration.value).toBe('4ZX2BX');
    expect(third.decision.action).toBe('confirm');
    expect(third.decision.slotKey).toBe('vehicleRegistration');
  });

  it('clears a provisional registration when the caller rejects it', async () => {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      JSON.stringify({
        userMove: 'provide_info',
        requestedSlotKey: null,
        slotUpdates: [
          { slotKey: 'serviceType', value: 'oil change', confidence: 0.92 },
        ],
        wantsEndCall: false,
        notes: '',
      }),
      'What is the vehicle registration?',
      JSON.stringify({
        userMove: 'provide_info',
        requestedSlotKey: null,
        slotUpdates: [
          {
            slotKey: 'vehicleRegistration',
            value: '2BX',
            confidence: 0.78,
          },
        ],
        wantsEndCall: false,
        notes: '',
      }),
      'I have the vehicle registration as 2 B X. Is that right?',
      'What is the vehicle registration?',
    );

    const first = await service.processTurn(
      session,
      task,
      'turn-1',
      'Oil change.',
    );
    sessions.appendHistory(session.id, {
      role: 'user',
      text: 'Oil change.',
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: first.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-1',
    });

    const second = await service.processTurn(session, task, 'turn-2', '2 B X.');
    sessions.appendHistory(session.id, {
      role: 'user',
      text: '2 B X.',
      at: new Date().toISOString(),
      turnId: 'turn-2',
    });
    sessions.appendHistory(session.id, {
      role: 'assistant',
      text: second.replyText,
      at: new Date().toISOString(),
      turnId: 'turn-2',
    });

    const third = await service.processTurn(
      session,
      task,
      'turn-3',
      "No, it's not.",
    );

    expect(third.decision.action).toBe('ask');
    expect(third.decision.slotKey).toBe('vehicleRegistration');
    expect(third.state.slots.vehicleRegistration.value).toBeNull();
    expect(third.state.slots.vehicleRegistration.status).toBe('missing');
  });
});
