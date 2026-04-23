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

  async function moveToPreferredDatePrompt() {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      'What is the vehicle registration?',
      'I have the vehicle registration as 4 Z X 2 B X. Is that right?',
      'Can I get your name for the booking?',
      'What is the best phone number for the booking?',
      'The phone number you provided is 0-4-8-2-9-0-6-0-5. Is that correct?',
      'What day would you like to book it for?',
    );

    await service.processTurn(session, task, 'turn-1', 'Oil change.');
    await service.processTurn(session, task, 'turn-2', '4ZX2BX');
    await service.processTurn(session, task, 'turn-3', "yes, that's correct");
    await service.processTurn(session, task, 'turn-4', 'Nick');
    await service.processTurn(session, task, 'turn-5', '048290605');
    const ready = await service.processTurn(
      session,
      task,
      'turn-6',
      "yes, that's correct",
    );

    expect(ready.decision.action).toBe('ask');
    expect(ready.decision.slotKey).toBe('preferredDate');

    return { session, task, reasoning, service };
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
      'THATSCORRECT',
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
      'NOTCORRECT',
    );

    expect(third.decision.action).toBe('ask');
    expect(third.decision.slotKey).toBe('vehicleRegistration');
    expect(third.state.slots.vehicleRegistration.value).toBeNull();
    expect(third.state.slots.vehicleRegistration.status).toBe('missing');
  });

  it('reopens registration when the caller says it is wrong after the flow moved on', async () => {
    const { sessions, tasks, reasoning, service } = createService();
    const session = sessions.create('car_booking_receptionist');
    const task = tasks.get('car_booking_receptionist');

    reasoning.enqueue(
      'What is the vehicle registration?',
      'I have the vehicle registration as 4 Z X 2. Is that right?',
      'Can I get your name for the booking?',
    );

    await service.processTurn(session, task, 'turn-1', 'Oil change.');
    await service.processTurn(session, task, 'turn-2', '4ZX2');
    const movedOn = await service.processTurn(
      session,
      task,
      'turn-3',
      "yes, that's correct.",
    );

    expect(movedOn.decision.action).toBe('ask');
    expect(movedOn.decision.slotKey).toBe('customerName');
    expect(movedOn.state.slots.vehicleRegistration.status).toBe('confirmed');

    const correction = await service.processTurn(
      session,
      task,
      'turn-4',
      'The registration is wrong.',
    );

    expect(correction.decision.action).toBe('ask');
    expect(correction.decision.slotKey).toBe('vehicleRegistration');
    expect(correction.decision.reason).toBe('slot_correction_requested');
    expect(correction.state.slots.vehicleRegistration.value).toBeNull();
    expect(correction.state.slots.vehicleRegistration.status).toBe('missing');
    expect(correction.state.slots.customerName.value).toBeNull();
  });

  it('captures a relative date and spoken time without asking for the date again', async () => {
    const { session, task, reasoning, service } =
      await moveToPreferredDatePrompt();

    reasoning.enqueue('Thanks, I have what I need for the booking.');

    const result = await service.processTurn(
      session,
      task,
      'turn-7',
      'Tomorrow at two p.m.',
    );

    expect(result.state.slots.preferredDate.value).toBe('tomorrow');
    expect(result.state.slots.preferredTime.value).toBe('2 pm');
    expect(result.decision.action).toBe('act');
    expect(result.decision.slotKey).toBeUndefined();
  });

  it('captures a weekday and spoken time in one turn', async () => {
    const { session, task, reasoning, service } =
      await moveToPreferredDatePrompt();

    reasoning.enqueue('Thanks, I have what I need for the booking.');

    const result = await service.processTurn(
      session,
      task,
      'turn-7',
      'Thursday at two p.m.',
    );

    expect(result.state.slots.preferredDate.value).toBe('thursday');
    expect(result.state.slots.preferredTime.value).toBe('2 pm');
    expect(result.decision.action).toBe('act');
    expect(result.decision.slotKey).toBeUndefined();
  });

  it('captures a spoken calendar date before a follow-up o clock time', async () => {
    const { session, task, reasoning, service } =
      await moveToPreferredDatePrompt();

    reasoning.enqueue(
      'Is there a preferred time of day?',
      'Thanks, I have what I need for the booking.',
    );

    const date = await service.processTurn(
      session,
      task,
      'turn-7',
      'Twenty fourth of April, twenty twenty six at.',
    );

    expect(date.state.slots.preferredDate.value).toBe('24 april 2026');
    expect(date.decision.action).toBe('act');

    const time = await service.processTurn(
      session,
      task,
      'turn-8',
      "It's at two o'clock.",
    );

    expect(time.state.slots.preferredDate.value).toBe('24 april 2026');
    expect(time.state.slots.preferredTime.value).toBe("2 o'clock");
    expect(time.decision.action).toBe('act');
  });
});
