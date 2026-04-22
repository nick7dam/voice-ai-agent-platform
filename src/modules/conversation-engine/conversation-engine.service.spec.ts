import type { AppConfig } from '../../config/app.config';
import { nowIso } from '../../common/utils/timing';
import { SessionsService } from '../sessions/sessions.service';
import { ConversationEngineService } from './conversation-engine.service';
import { ConversationProfileRegistryService } from './conversation-profile.registry';
import { DialoguePolicyService } from './dialogue-policy.service';
import { LiveIntentStateService } from './live-intent-state.service';
import { SemanticPatchService } from './semantic-patch.service';
import { TranscriptLayerService } from './transcript-layer.service';

describe('ConversationEngineService', () => {
  const config = {
    defaultTaskKey: 'car_booking_receptionist',
  } as AppConfig;

  function createService() {
    const sessions = new SessionsService(config);
    const profiles = new ConversationProfileRegistryService();
    const transcriptLayer = new TranscriptLayerService();
    const semantic = new SemanticPatchService();
    const liveIntent = new LiveIntentStateService(profiles);
    const policy = new DialoguePolicyService();
    const service = new ConversationEngineService(
      sessions,
      profiles,
      transcriptLayer,
      semantic,
      liveIntent,
      policy,
    );

    return {
      sessions,
      service,
    };
  }

  it('assembles fragments into one committed thought and asks for the next missing slot', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    const first = service.ingestFragment(session.id, 'I need an oil change');
    expect(first.decision.action).toBe('wait');
    expect(first.liveIntent.pendingThought.text).toBe('I need an oil change');

    const second = service.ingestFragment(session.id, 'rego ABC123');
    expect(second.decision.action).toBe('wait');
    expect(second.liveIntent.pendingThought.text).toBe(
      'I need an oil change rego ABC123',
    );

    const committed = service.commitPendingThought(session.id, 'hold_timeout');
    expect(committed).not.toBeNull();
    expect(committed?.committedUserText).toBe(
      'I need an oil change rego ABC123',
    );
    expect(committed?.liveIntent.slots.serviceType.value).toBe('oil change');
    expect(committed?.liveIntent.slots.serviceType.status).toBe('confirmed');
    expect(committed?.liveIntent.slots.vehicleRegistration.value).toBe(
      'ABC123',
    );
    expect(committed?.liveIntent.slots.vehicleRegistration.status).toBe(
      'confirmed',
    );
    expect(committed?.decision.action).toBe('ask');
    expect(committed?.decision.slotKey).toBe('customerName');
  });

  it('moves to action once the booking-ready slots are filled in one clean turn', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'I need an oil change for rego ABC123. My name is Sarah Jones. My phone number is 0412345678. Next Friday please.',
    );

    const committed = service.commitPendingThought(session.id, 'hold_timeout');
    expect(committed).not.toBeNull();
    expect(committed?.liveIntent.slots.serviceType.value).toBe('oil change');
    expect(committed?.liveIntent.slots.vehicleRegistration.value).toBe(
      'ABC123',
    );
    expect(committed?.liveIntent.slots.customerName.value).toBe('Sarah Jones');
    expect(committed?.liveIntent.slots.phoneNumber.canonicalValue).toBe(
      '0412345678',
    );
    expect(committed?.liveIntent.slots.preferredDate.value).toBe('next friday');
    expect(committed?.decision.action).toBe('act');
    expect(committed?.decision.reason).toBe('minimum_booking_context_ready');
    expect(committed?.decision.shouldReason).toBe(true);
  });

  it('captures a spelled registration after prompting and asks for confirmation', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.action).toBe('ask');
    expect(firstCommit?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, 'A B C 1 2 3');
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.vehicleRegistration.value).toBe(
      'ABC123',
    );
    expect(committed?.liveIntent.slots.vehicleRegistration.status).toBe(
      'provisional',
    );
    expect(committed?.liveIntent.slots.vehicleRegistration.needsConfirmation).toBe(
      true,
    );
    expect(committed?.decision.action).toBe('confirm');
    expect(committed?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('captures a spoken phone number after prompting and asks for confirmation', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'Oil change, rego ABC123, my name is Sarah Jones.',
    );
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.action).toBe('ask');
    expect(firstCommit?.decision.slotKey).toBe('phoneNumber');

    service.ingestFragment(
      session.id,
      'zero four one two three four five six seven eight',
    );
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.phoneNumber.value).toBe('0412 345 678');
    expect(committed?.liveIntent.slots.phoneNumber.canonicalValue).toBe(
      '0412345678',
    );
    expect(committed?.liveIntent.slots.phoneNumber.needsConfirmation).toBe(
      true,
    );
    expect(committed?.decision.action).toBe('confirm');
    expect(committed?.decision.slotKey).toBe('phoneNumber');
  });

  it('clears a prompted slot when the caller says no during confirmation', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    service.commitPendingThought(session.id, 'hold_timeout');

    service.ingestFragment(session.id, 'A B C 1 2 3');
    const confirmation = service.commitPendingThought(session.id, 'hold_timeout');
    expect(confirmation?.decision.action).toBe('confirm');
    expect(confirmation?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, 'No.');
    const retry = service.commitPendingThought(session.id, 'hold_timeout');

    expect(retry?.liveIntent.slots.vehicleRegistration.value).toBeNull();
    expect(retry?.decision.action).toBe('ask');
    expect(retry?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('infers confirmation context from the last assistant reply when the prompt focus is empty', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'Oil change rego 4ZX2B. My name is Nick. My phone number is 0482906050. Friday.',
    );
    const committed = service.commitPendingThought(session.id, 'hold_timeout');
    expect(committed?.decision.action).toBe('act');

    const liveSession = sessions.get(session.id);
    liveSession.assistantDraftTurn = {
      turnId: 'turn-confirm',
      text: 'Your vehicle registration is 4ZX2B. Is that correct?',
      finalized: true,
      updatedAt: nowIso(),
    };

    service.ingestFragment(session.id, 'No.');
    const retry = service.commitPendingThought(session.id, 'hold_timeout');

    expect(retry?.liveIntent.slots.vehicleRegistration.value).toBeNull();
    expect(retry?.decision.action).toBe('ask');
    expect(retry?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('can explicitly read back an already captured registration', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change rego ABC123.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('customerName');

    service.ingestFragment(session.id, 'Can you read back the rego please?');
    const confirmation = service.commitPendingThought(session.id, 'hold_timeout');

    expect(confirmation?.decision.action).toBe('confirm');
    expect(confirmation?.decision.slotKey).toBe('vehicleRegistration');
    expect(confirmation?.decision.responseText).toContain(
      'vehicle registration',
    );
    expect(confirmation?.decision.responseText).toContain('A B C 1 2 3');
  });
});
