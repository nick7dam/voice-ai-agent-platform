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

  it('assembles a receptionist thought across fragments before asking for the next slot', () => {
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
    expect(committed?.decision.responseText).toBe(
      'Can I get your name for the booking? You can spell it if that is easier.',
    );
  });

  it('moves to action once the booking-ready slots are filled', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'I need an oil change for rego ABC123. My name is Sarah Jones. My phone number is 0412345678. Next Friday please.',
    );

    const committed = service.commitPendingThought(session.id, 'hold_timeout');
    expect(committed).not.toBeNull();
    expect(committed?.decision.action).toBe('act');
    expect(committed?.decision.reason).toBe('minimum_booking_context_ready');
    expect(committed?.decision.shouldReason).toBe(true);
  });

  it('captures a spelled registration across multiple fragments after asking for it', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('vehicleRegistration');

    const firstSpelling = service.ingestFragment(session.id, 'A B C');
    expect(firstSpelling.decision.reason).toBe('registration_capture_incomplete');

    service.ingestFragment(session.id, 'D 2 4');
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.vehicleRegistration.value).toBe('ABCD24');
    expect(committed?.decision.action).toBe('confirm');
    expect(committed?.decision.slotKey).toBe('vehicleRegistration');
    expect(committed?.decision.shouldReason).toBe(true);
  });

  it('captures a phone number spoken digit by digit', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'Oil change, rego ABC123, my name is Sarah Jones.',
    );
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('phoneNumber');

    service.ingestFragment(
      session.id,
      'zero four one two three four five six seven eight',
    );
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.phoneNumber.value).toBe('0412 3456 78');
    expect(committed?.liveIntent.slots.phoneNumber.canonicalValue).toBe(
      '0412345678',
    );
    expect(committed?.decision.slotKey).toBe('preferredDate');
  });

  it('captures a spoken email address', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'My email is sarah dot jones at gmail dot com.',
    );
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.customerEmail.value).toBe(
      'sarah.jones@gmail.com',
    );
  });

  it('normalizes low-latency fused spelling for vehicle registration capture', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, 'ABC duty 4');
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.vehicleRegistration.value).toBe(
      'ABCD24',
    );
    expect(committed?.decision.action).toBe('confirm');
    expect(committed?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('captures a spelled customer name after asking for it', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change rego ABC123.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('customerName');

    service.ingestFragment(session.id, 'S A R A H');
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.customerName.value).toBe('Sarah');
    expect(committed?.decision.slotKey).toBe('phoneNumber');
  });

  it('keeps a weak merged registration in confirmation instead of advancing', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, 'for ZX BX');
    const committed = service.commitPendingThought(session.id, 'hold_timeout');

    expect(committed?.liveIntent.slots.vehicleRegistration.value).toBe('4ZXBX');
    expect(committed?.liveIntent.slots.vehicleRegistration.status).toBe(
      'provisional',
    );
    expect(committed?.liveIntent.slots.vehicleRegistration.needsConfirmation).toBe(
      true,
    );
    expect(committed?.decision.action).toBe('confirm');
    expect(committed?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('clears a bad registration after the caller says it is wrong', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    service.commitPendingThought(session.id, 'hold_timeout');

    service.ingestFragment(session.id, 'for ZX BX');
    const confirmation = service.commitPendingThought(session.id, 'hold_timeout');
    expect(confirmation?.decision.action).toBe('confirm');
    expect(confirmation?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, "That's not the correct registration.");
    const correction = service.commitPendingThought(session.id, 'hold_timeout');

    expect(correction?.liveIntent.slots.vehicleRegistration.value).toBeNull();
    expect(correction?.decision.action).toBe('ask');
    expect(correction?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('uses prompt focus so a plain no clears the slot being confirmed', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    service.commitPendingThought(session.id, 'hold_timeout');

    service.ingestFragment(session.id, 'ABC duty 4');
    const confirmation = service.commitPendingThought(session.id, 'hold_timeout');
    expect(confirmation?.decision.action).toBe('confirm');
    expect(confirmation?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, 'No');
    const retry = service.commitPendingThought(session.id, 'hold_timeout');

    expect(retry?.liveIntent.slots.vehicleRegistration.value).toBeNull();
    expect(retry?.decision.action).toBe('ask');
    expect(retry?.decision.slotKey).toBe('vehicleRegistration');
  });

  it('infers confirmation context from the assistant reply and clears the rego on no', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(
      session.id,
      'Oil change rego 4ZX2B. My name is Nick. My phone number is 0482906050. Friday.',
    );
    service.commitPendingThought(session.id, 'hold_timeout');

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

  it('can explicitly confirm an already captured registration without losing the flow', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change rego ABC123.');
    const firstCommit = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstCommit?.decision.slotKey).toBe('customerName');

    service.ingestFragment(
      session.id,
      'Can you confirm the registration with me please?',
    );
    const confirmation = service.commitPendingThought(session.id, 'hold_timeout');

    expect(confirmation?.decision.action).toBe('confirm');
    expect(confirmation?.decision.slotKey).toBe('vehicleRegistration');
    expect(confirmation?.decision.responseText).toContain(
      'vehicle registration',
    );
    expect(confirmation?.decision.responseText).toContain('A B C 1 2 3');
  });

  it('accumulates a registration across multiple committed partial spelling turns', () => {
    const { sessions, service } = createService();
    const session = sessions.create('car_booking_receptionist');

    service.ingestFragment(session.id, 'Oil change.');
    service.commitPendingThought(session.id, 'hold_timeout');

    service.ingestFragment(session.id, 'Z');
    const firstPartial = service.commitPendingThought(session.id, 'hold_timeout');
    expect(firstPartial?.liveIntent.slots.vehicleRegistration.value).toBe('Z');
    expect(firstPartial?.decision.slotKey).toBe('vehicleRegistration');
    expect(firstPartial?.decision.shouldReason).toBe(true);

    service.ingestFragment(session.id, 'BX');
    const secondPartial = service.commitPendingThought(session.id, 'hold_timeout');
    expect(secondPartial?.liveIntent.slots.vehicleRegistration.value).toBe('ZBX');
    expect(secondPartial?.decision.slotKey).toBe('vehicleRegistration');

    service.ingestFragment(session.id, '2 B');
    const completed = service.commitPendingThought(session.id, 'hold_timeout');
    expect(completed?.liveIntent.slots.vehicleRegistration.value).toBe('ZBX2B');
    expect(['confirm', 'ask']).toContain(completed?.decision.action ?? '');
  });
});
