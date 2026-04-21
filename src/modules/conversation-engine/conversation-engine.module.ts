import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ConversationEngineService } from './conversation-engine.service';
import { ConversationProfileRegistryService } from './conversation-profile.registry';
import { DialoguePolicyService } from './dialogue-policy.service';
import { LiveIntentStateService } from './live-intent-state.service';
import { SemanticPatchService } from './semantic-patch.service';
import { TranscriptLayerService } from './transcript-layer.service';

@Module({
  imports: [SessionsModule],
  providers: [
    ConversationEngineService,
    ConversationProfileRegistryService,
    TranscriptLayerService,
    SemanticPatchService,
    LiveIntentStateService,
    DialoguePolicyService,
  ],
  exports: [ConversationEngineService, ConversationProfileRegistryService],
})
export class ConversationEngineModule {}
