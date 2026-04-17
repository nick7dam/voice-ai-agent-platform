import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { MemoryService } from './memory.service';

@Module({
  imports: [SessionsModule],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
