import type { AppConfig } from '../../config/app.config';
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
      'Can I get your name for the booking?',
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
});
