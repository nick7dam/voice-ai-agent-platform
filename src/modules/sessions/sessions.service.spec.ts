import type { AppConfig } from '../../config/app.config';
import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  const config = {
    defaultTaskKey: 'general_voice_assistant',
  } as AppConfig;

  it('captures interrupted assistant draft context', () => {
    const service = new SessionsService(config);
    const session = service.create();
    const turnId = service.beginTextTurn(session.id);

    service.noteAssistantText(
      session.id,
      turnId,
      'Let me check tomorrow afternoon for you.',
      false,
    );

    service.interrupt(session.id, 'barge_in');

    const updated = service.get(session.id);
    expect(updated.interruptedAssistantTurn).toEqual({
      turnId,
      text: 'Let me check tomorrow afternoon for you.',
      reason: 'barge_in',
      at: expect.any(String),
      finalized: false,
    });
  });

  it('uses finalized assistant turn text when interrupted after response emission', () => {
    const service = new SessionsService(config);
    const session = service.create();
    const turnId = service.beginTextTurn(session.id);

    service.noteAssistantText(
      session.id,
      turnId,
      'We are open tomorrow afternoon. Can I help with a booking?',
      true,
    );
    service.appendHistory(session.id, {
      role: 'assistant',
      text: 'We are open tomorrow afternoon. Can I help with a booking?',
      at: new Date().toISOString(),
      turnId,
    });

    service.interrupt(session.id, 'client_interrupt');

    expect(service.get(session.id).interruptedAssistantTurn).toMatchObject({
      turnId,
      text: 'We are open tomorrow afternoon. Can I help with a booking?',
      reason: 'client_interrupt',
      finalized: true,
    });
  });
});
