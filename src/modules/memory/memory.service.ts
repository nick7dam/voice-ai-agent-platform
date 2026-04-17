import { Injectable } from '@nestjs/common';
import { MemoryFact } from '../../common/types/session.types';
import { SessionsService } from '../sessions/sessions.service';

@Injectable()
export class MemoryService {
  constructor(private readonly sessions: SessionsService) {}

  rememberFact(sessionId: string, fact: string, category?: string): MemoryFact {
    return this.sessions.addMemoryFact(sessionId, fact, category);
  }

  listMemory(sessionId: string, limit?: number): MemoryFact[] {
    return this.sessions.listMemory(sessionId, limit);
  }
}
