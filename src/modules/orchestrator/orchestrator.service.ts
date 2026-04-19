import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ServerEvent } from '../../common/types/realtime-events';
import { ChatMessage } from '../../common/types/reasoning.types';
import { SessionState } from '../../common/types/session.types';
import { NormalizedToolResult, ToolCall } from '../../common/types/tool.types';
import { elapsedMs, nowIso } from '../../common/utils/timing';
import { ReasoningService } from '../reasoning/reasoning.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskRegistryService } from '../tasks/task-registry.service';
import { TaskConfig } from '../tasks/task-config.types';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ToolRuntimeService } from '../tools/tool-runtime.service';
import { TtsService } from '../tts/tts.service';
import { PromptBuilderService } from './prompt-builder.service';
import { AppError, toErrorPayload } from '../../common/types/errors';

export type OrchestratorEmit = (event: ServerEvent) => void;

type StructuredCaptureField = 'phone' | 'registration';

interface StructuredCaptureState {
  field: StructuredCaptureField;
  value: string;
  display: string;
  rawTranscript: string;
  attempts: number;
  createdAt: string;
}

interface StructuredCaptureResult {
  text: string;
  providerLatencyMs: number;
  toolResults: NormalizedToolResult[];
  askedModelForTools: boolean;
  toolsUsed: boolean;
}

interface ConfirmedDetail {
  value: string;
  display: string;
  confirmedAt: string;
}

interface ConfirmedSessionDetails {
  phone?: ConfirmedDetail;
  registration?: ConfirmedDetail;
  serviceType?: ConfirmedDetail;
  customerId?: ConfirmedDetail;
  vehicleId?: ConfirmedDetail;
}

type ConfirmedDetailKey = keyof ConfirmedSessionDetails;

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly callEndMarker = '[[END_CALL]]';
  private readonly receptionistRuntimeTools = [
    'get_workshop_info',
    'find_customer_by_phone',
    'create_customer',
    'find_vehicle_by_rego',
    'create_vehicle',
    'find_latest_booking_by_phone',
    'check_booking_availability',
    'create_booking',
    'create_escalation',
  ];

  constructor(
    private readonly sessions: SessionsService,
    private readonly tasks: TaskRegistryService,
    private readonly prompts: PromptBuilderService,
    private readonly reasoning: ReasoningService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly toolRuntime: ToolRuntimeService,
    private readonly tts: TtsService,
  ) {}

  async handleTranscript(
    sessionId: string,
    turnId: string,
    transcript: string,
    emit: OrchestratorEmit,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();

    try {
      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        this.logger.log(
          `reasoning.skip_stale session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      const trimmedTranscript = transcript.trim();
      if (!trimmedTranscript) {
        this.sessions.appendHistory(sessionId, {
          role: 'assistant',
          text: "I didn't catch that. Please try again.",
          at: nowIso(),
        });
        emit({
          type: 'assistant.response',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            text: "I didn't catch that. Please try again.",
            latencyMs: elapsedMs(startedAt),
          },
        });
        this.sessions.setState(sessionId, 'idle');
        return;
      }

      this.sessions.setState(sessionId, 'reasoning');
      emit({
        type: 'reasoning.started',
        sessionId,
        timestamp: nowIso(),
        payload: { turnId },
      });

      const session = this.sessions.get(sessionId);
      const task = this.withRuntimeRequiredTools(
        this.tasks.get(session.taskKey, true),
      );
      this.captureObviousConfirmedDetails(
        sessionId,
        session,
        trimmedTranscript,
      );
      const messages = this.prompts.build(session, task, trimmedTranscript);
      const tools = this.toolRegistry.toLlmTools(task.allowedTools);

      this.sessions.appendHistory(sessionId, {
        role: 'user',
        text: trimmedTranscript,
        at: nowIso(),
      });

      this.logger.log(`reasoning.start session=${sessionId} turn=${turnId}`);
      let earlyAudioStarted = false;
      let firstTokenEmitted = false;
      let speechCursor = 0;
      let speechTextChunkIndex = 0;
      let queuedSpeech = Promise.resolve();
      let streamedText = '';
      const emitFirstToken = (source: 'stream' | 'generate') => {
        if (firstTokenEmitted) {
          return;
        }

        firstTokenEmitted = true;
        emit({
          type: 'reasoning.first_token',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            latencyMs: elapsedMs(startedAt),
            source,
          },
        });
      };
      const emitSpeechTextChunk = (text: string, final: boolean) => {
        const speech = this.sanitizeAssistantPlainText(text);

        if (!speech) {
          return;
        }

        emit({
          type: 'assistant.text.chunk',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            text: speech,
            index: speechTextChunkIndex,
            final,
          },
        });
        speechTextChunkIndex += 1;
      };
      const queueEarlySpeech = (text: string) => {
        if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
          return;
        }

        const speech = text.replace(/\s+/g, ' ').trim();

        if (!speech) {
          return;
        }

        earlyAudioStarted = true;
        this.logger.log(
          `tts.early.start session=${sessionId} turn=${turnId} chars=${speech.length}`,
        );
        queuedSpeech = queuedSpeech
          .then(async () => {
            if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
              return;
            }

            await this.emitAssistantAudio(sessionId, turnId, speech, emit);
          })
          .catch((error: unknown) => {
            const payload = toErrorPayload(error);
            this.logger.warn(
              `tts.early.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message}`,
            );
          });
      };
      const ensureTurnCurrent = () => {
        if (!this.isTurnCurrent(sessionId, turnId)) {
          throw new AppError(
            'TURN_INTERRUPTED',
            'Reasoning stopped because a newer turn interrupted this response.',
          );
        }
      };
      const toolResultsForTurn: NormalizedToolResult[] = [];
      let finalText = '';
      let providerLatencyMs = 0;
      let shouldAskModelForTools = false;
      let toolsUsed = false;

      const structuredCapture = await this.handleStructuredCaptureTurn(
        sessionId,
        turnId,
        trimmedTranscript,
        task,
        session,
        messages,
        emit,
      );

      if (structuredCapture) {
        finalText = structuredCapture.text;
        providerLatencyMs = structuredCapture.providerLatencyMs;
        shouldAskModelForTools = structuredCapture.askedModelForTools;
        toolsUsed = structuredCapture.toolsUsed;
        toolResultsForTurn.push(...structuredCapture.toolResults);
        this.rememberToolResultDetails(
          sessionId,
          session,
          structuredCapture.toolResults,
        );
      } else {
        const deterministicToolCalls = this.buildDeterministicToolCalls(
          trimmedTranscript,
          task,
          session,
        );
        shouldAskModelForTools =
          deterministicToolCalls.length > 0 ||
          this.shouldUseTools(trimmedTranscript);
        toolsUsed = deterministicToolCalls.length > 0;

        if (deterministicToolCalls.length > 0) {
          emitFirstToken('generate');
          const final = await this.generateAfterTools(
            sessionId,
            turnId,
            task,
            messages,
            "I'll check that.",
            deterministicToolCalls,
            emit,
          );
          finalText = final.text;
          providerLatencyMs = final.providerLatencyMs;
          toolResultsForTurn.push(...final.toolResults);
          this.rememberToolResultDetails(sessionId, session, final.toolResults);
        } else {
          const initial = shouldAskModelForTools
            ? await this.reasoning.generate({
                messages,
                tools,
                temperature: 0.2,
              })
            : await this.reasoning.stream(
                {
                  messages,
                  temperature: 0.15,
                },
                {
                  onTextDelta: (delta) => {
                    ensureTurnCurrent();
                    streamedText += delta;
                    if (delta.trim()) {
                      emitFirstToken('stream');
                    }

                    const chunks = this.extractSpeechChunks(
                      streamedText,
                      speechCursor,
                      false,
                    );

                    for (const chunk of chunks) {
                      speechCursor = chunk.endIndex;
                      emitSpeechTextChunk(chunk.text, false);

                      if (
                        this.tts.isEnabled() &&
                        this.tts.shouldEmitEarlyAudio() &&
                        this.sessions.isAudioOutputEnabled(sessionId)
                      ) {
                        if (this.tts.shouldStreamPhrases()) {
                          queueEarlySpeech(chunk.text);
                        } else if (!earlyAudioStarted) {
                          queueEarlySpeech(chunk.text);
                        }
                      }
                    }
                  },
                },
              );

          finalText = initial.text;
          providerLatencyMs = initial.latencyMs;
          if (shouldAskModelForTools) {
            emitFirstToken('generate');
          }

          if (!this.isTurnCurrent(sessionId, turnId)) {
            this.logger.log(
              `reasoning.skip_stale_after_initial session=${sessionId} turn=${turnId}`,
            );
            return;
          }

          const inferredToolCalls =
            initial.toolCalls.length > 0
              ? initial.toolCalls
              : this.inferToolCallsFromAssistantText(
                  initial.text,
                  task,
                  trimmedTranscript,
                  session,
                );

          if (inferredToolCalls.length > 0) {
            toolsUsed = true;
            if (initial.toolCalls.length === 0) {
              this.logger.warn(
                `reasoning.pseudo_tool_call session=${sessionId} turn=${turnId} calls=${inferredToolCalls.map((call) => call.name).join(',')}`,
              );
            }

            const final = await this.generateAfterTools(
              sessionId,
              turnId,
              task,
              messages,
              initial.toolCalls.length > 0 ? initial.text : "I'll check that.",
              inferredToolCalls,
              emit,
            );
            finalText = final.text;
            providerLatencyMs += final.providerLatencyMs;
            toolResultsForTurn.push(...final.toolResults);
            this.rememberToolResultDetails(
              sessionId,
              session,
              final.toolResults,
            );
          }
        }
      }

      if (!this.isTurnCurrent(sessionId, turnId)) {
        this.logger.log(
          `assistant.response.skip_stale session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      const shouldEndCall =
        this.shouldEndCall(finalText) ||
        this.isCallEndingUserText(trimmedTranscript);
      const groundedText = this.enforceGroundedToolClaims(
        finalText,
        trimmedTranscript,
        toolResultsForTurn,
      );
      const nonRepeatingText = this.avoidRepeatedKnownQuestions(
        groundedText,
        session,
      );
      const safeText = this.normalizeAssistantText(nonRepeatingText, task);
      const totalLatencyMs = elapsedMs(startedAt);
      this.sessions.appendHistory(sessionId, {
        role: 'assistant',
        text: safeText,
        at: nowIso(),
      });
      this.sessions.setState(sessionId, 'idle');

      const finalSpeechChunks = this.extractSpeechChunks(
        safeText,
        speechCursor,
        true,
      );
      for (const chunk of finalSpeechChunks) {
        speechCursor = chunk.endIndex;
        emitSpeechTextChunk(chunk.text, true);

        if (earlyAudioStarted && this.tts.shouldStreamPhrases()) {
          queueEarlySpeech(chunk.text);
        }
      }

      emit({
        type: 'assistant.response',
        sessionId,
        timestamp: nowIso(),
        payload: {
          turnId,
          text: safeText,
          latencyMs: totalLatencyMs,
        },
      });

      if (shouldEndCall) {
        emit({
          type: 'session.end_requested',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            reason: 'assistant_completed_call',
          },
        });
      }

      if (!earlyAudioStarted) {
        void this.emitAssistantAudio(sessionId, turnId, safeText, emit);
      }

      this.logger.log(
        `reasoning.end session=${sessionId} turn=${turnId} latencyMs=${totalLatencyMs} providerLatencyMs=${providerLatencyMs} toolsEnabled=${shouldAskModelForTools} toolsUsed=${toolsUsed} earlyAudio=${earlyAudioStarted}`,
      );
    } catch (error) {
      const payload = toErrorPayload(error);

      if (
        payload.code === 'TURN_INTERRUPTED' ||
        !this.isTurnCurrent(sessionId, turnId)
      ) {
        this.logger.log(
          `reasoning.cancelled session=${sessionId} turn=${turnId} code=${payload.code}`,
        );
        return;
      }

      this.sessions.setState(sessionId, 'idle');
      emit({
        type: 'error',
        sessionId,
        timestamp: nowIso(),
        payload,
      });
      this.logger.error(
        `reasoning.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message}`,
      );
    }
  }

  private isTurnCurrent(sessionId: string, turnId: string): boolean {
    try {
      return this.sessions.isCurrentTurn(sessionId, turnId);
    } catch {
      return false;
    }
  }

  private captureObviousConfirmedDetails(
    sessionId: string,
    session: SessionState,
    transcript: string,
  ): void {
    const serviceType = this.inferServiceType(transcript);
    if (!serviceType) {
      return;
    }

    const display = this.serviceTypeDisplay(serviceType);
    this.rememberConfirmedDetail(
      sessionId,
      session,
      'serviceType',
      serviceType,
      display,
      `Confirmed service type: ${display}.`,
    );
  }

  private rememberStructuredCaptureConfirmation(
    sessionId: string,
    session: SessionState,
    capture: StructuredCaptureState,
  ): void {
    if (capture.field === 'phone') {
      this.rememberConfirmedDetail(
        sessionId,
        session,
        'phone',
        capture.value,
        capture.display,
        `Confirmed phone number: ${capture.display}.`,
      );
      return;
    }

    this.rememberConfirmedDetail(
      sessionId,
      session,
      'registration',
      capture.value.toUpperCase(),
      capture.display,
      `Confirmed registration: ${capture.display}.`,
    );
  }

  private rememberToolResultDetails(
    sessionId: string,
    session: SessionState,
    results: NormalizedToolResult[],
  ): void {
    for (const result of results) {
      if (!result.ok || !this.isRecord(result.output)) {
        continue;
      }

      if (
        result.name === 'find_customer_by_phone' ||
        result.name === 'create_customer'
      ) {
        const phone = this.extractPhoneFromToolOutput(result.output);
        if (phone) {
          this.rememberConfirmedDetail(
            sessionId,
            session,
            'phone',
            phone.value,
            phone.display,
            `Confirmed phone number: ${phone.display}.`,
          );
        }

        const customerId = this.extractEntityId(result.output, 'customer');
        if (customerId) {
          this.rememberConfirmedDetail(
            sessionId,
            session,
            'customerId',
            customerId,
            customerId,
            `Confirmed customer id: ${customerId}.`,
          );
        }
      }

      if (
        result.name === 'find_vehicle_by_rego' ||
        result.name === 'create_vehicle'
      ) {
        const registration = this.asString(result.output.registration);
        if (registration) {
          const normalized = registration.toUpperCase();
          this.rememberConfirmedDetail(
            sessionId,
            session,
            'registration',
            normalized,
            this.spokenRegistrationForConfirmation(normalized),
            `Confirmed registration: ${this.spokenRegistrationForConfirmation(normalized)}.`,
          );
        }

        const vehicleId = this.extractEntityId(result.output, 'vehicle');
        if (vehicleId) {
          this.rememberConfirmedDetail(
            sessionId,
            session,
            'vehicleId',
            vehicleId,
            vehicleId,
            `Confirmed vehicle id: ${vehicleId}.`,
          );
        }
      }
    }
  }

  private rememberConfirmedDetail(
    sessionId: string,
    session: SessionState,
    key: ConfirmedDetailKey,
    value: string,
    display: string,
    memoryFact: string,
  ): boolean {
    const normalizedValue = value.trim();
    const normalizedDisplay = display.trim();
    if (!normalizedValue || !normalizedDisplay) {
      return false;
    }

    const confirmed = this.getConfirmedDetails(session);
    const existing = confirmed[key];
    if (
      existing?.value === normalizedValue &&
      existing.display === normalizedDisplay
    ) {
      return false;
    }

    this.setConfirmedDetail(session, key, {
      value: normalizedValue,
      display: normalizedDisplay,
      confirmedAt: nowIso(),
    });
    this.sessions.addMemoryFact(sessionId, memoryFact, 'confirmed_detail');
    this.logger.log(
      `session.confirmed_detail session=${sessionId} key=${key} value=${normalizedValue}`,
    );
    return true;
  }

  private getConfirmedDetails(session: SessionState): ConfirmedSessionDetails {
    const details = session.metadata?.confirmedDetails;
    if (!this.isRecord(details)) {
      return {};
    }

    return {
      phone: this.asConfirmedDetail(details.phone),
      registration: this.asConfirmedDetail(details.registration),
      serviceType: this.asConfirmedDetail(details.serviceType),
      customerId: this.asConfirmedDetail(details.customerId),
      vehicleId: this.asConfirmedDetail(details.vehicleId),
    };
  }

  private setConfirmedDetail(
    session: SessionState,
    key: ConfirmedDetailKey,
    detail: ConfirmedDetail,
  ): void {
    const existing = this.getConfirmedDetails(session);
    session.metadata = {
      ...(session.metadata ?? {}),
      confirmedDetails: {
        ...existing,
        [key]: detail,
      },
    };
  }

  private asConfirmedDetail(value: unknown): ConfirmedDetail | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const detailValue = this.asString(value.value);
    const display = this.asString(value.display);
    if (!detailValue || !display) {
      return undefined;
    }

    return {
      value: detailValue,
      display,
      confirmedAt: this.asString(value.confirmedAt) ?? nowIso(),
    };
  }

  private extractPhoneFromToolOutput(
    output: Record<string, unknown>,
  ): { value: string; display: string } | undefined {
    const phone = output.phone;
    if (!this.isRecord(phone)) {
      return undefined;
    }

    const value = this.asString(phone.e164);
    const display =
      this.asString(phone.display) ??
      this.spokenPhoneForConfirmation(this.asString(phone.nationalDigits));

    return value && display ? { value, display } : undefined;
  }

  private extractEntityId(
    output: Record<string, unknown>,
    entityKey: 'customer' | 'vehicle',
  ): string | undefined {
    return (
      this.extractId(output[entityKey]) ??
      this.extractId(output.data) ??
      this.extractId(output)
    );
  }

  private extractId(value: unknown): string | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const direct =
      this.asString(value.id) ??
      this.asString(value.uuid) ??
      this.asString(value.customerId) ??
      this.asString(value.customer_id) ??
      this.asString(value.vehicleId) ??
      this.asString(value.vehicle_id);
    if (direct) {
      return direct;
    }

    if (typeof value.id === 'number' && Number.isFinite(value.id)) {
      return String(value.id);
    }

    return undefined;
  }

  private avoidRepeatedKnownQuestions(
    text: string,
    session: SessionState,
  ): string {
    const confirmed = this.getConfirmedDetails(session);

    if (confirmed.phone && this.asksForPhone(text)) {
      return `I have your phone number confirmed. ${this.nextMissingDetailQuestion(confirmed)}`;
    }

    if (confirmed.registration && this.asksForRegistration(text)) {
      return `I have registration ${confirmed.registration.display} confirmed. ${this.nextMissingDetailQuestion(confirmed)}`;
    }

    if (confirmed.serviceType && this.asksForServiceType(text)) {
      return `I have ${confirmed.serviceType.display} noted. ${this.nextMissingDetailQuestion(confirmed)}`;
    }

    return text;
  }

  private asksForPhone(text: string): boolean {
    return (
      /\b(phone|mobile|contact number|best number)\b[^?]{0,100}\?/i.test(
        text,
      ) ||
      /\b(can i|get|have|what'?s|what is|confirm|repeat)\b[^?]{0,80}\b(number)\b[^?]{0,40}\?/i.test(
        text,
      )
    );
  }

  private asksForRegistration(text: string): boolean {
    return /\b(rego|registration|plate|licen[cs]e plate)\b[^?]{0,100}\?/i.test(
      text,
    );
  }

  private asksForServiceType(text: string): boolean {
    return /\b(what type of service|which service|what service|service do you need|what are we booking|what can we book)\b/i.test(
      text,
    );
  }

  private nextMissingDetailQuestion(details: ConfirmedSessionDetails): string {
    if (!details.serviceType) {
      return 'What type of service do you need?';
    }

    if (!details.phone) {
      return "What's the best phone number?";
    }

    if (!details.registration) {
      return "What's the vehicle registration?";
    }

    return 'What day works best for the booking?';
  }

  private serviceTypeDisplay(serviceType: string): string {
    return serviceType.replace(/_/g, ' ');
  }

  private async handleStructuredCaptureTurn(
    sessionId: string,
    turnId: string,
    transcript: string,
    task: TaskConfig,
    session: SessionState,
    messages: ChatMessage[],
    emit: OrchestratorEmit,
  ): Promise<StructuredCaptureResult | undefined> {
    const pending = this.getStructuredCapture(session);

    if (pending) {
      if (this.isAffirmative(transcript)) {
        this.clearStructuredCapture(session);
        this.rememberStructuredCaptureConfirmation(sessionId, session, pending);
        const toolName =
          pending.field === 'phone'
            ? 'find_customer_by_phone'
            : 'find_vehicle_by_rego';
        const args =
          pending.field === 'phone'
            ? { phone: pending.value }
            : { registration: pending.value };
        const final = await this.generateAfterTools(
          sessionId,
          turnId,
          task,
          messages,
          "I'll check that.",
          [this.createToolCall(toolName, args)],
          emit,
        );

        return {
          text: final.text,
          providerLatencyMs: final.providerLatencyMs,
          toolResults: final.toolResults,
          askedModelForTools: true,
          toolsUsed: true,
        };
      }

      const correction = this.detectStructuredCaptureCandidate(
        transcript,
        session,
        pending.field,
      );
      if (correction) {
        this.setStructuredCapture(session, correction);
        return {
          text: this.confirmStructuredCaptureText(correction),
          providerLatencyMs: 0,
          toolResults: [],
          askedModelForTools: false,
          toolsUsed: false,
        };
      }

      if (this.isNegative(transcript)) {
        pending.attempts += 1;
        this.setStructuredCapture(session, pending);
        return {
          text:
            pending.field === 'phone'
              ? 'No problem. Please repeat the phone number one digit at a time.'
              : 'No problem. Please repeat the registration one character at a time.',
          providerLatencyMs: 0,
          toolResults: [],
          askedModelForTools: false,
          toolsUsed: false,
        };
      }

      return {
        text: `Just to confirm, I heard ${pending.display}. Is that correct?`,
        providerLatencyMs: 0,
        toolResults: [],
        askedModelForTools: false,
        toolsUsed: false,
      };
    }

    const detected = this.detectStructuredCaptureCandidate(transcript, session);
    if (!detected) {
      return undefined;
    }

    this.setStructuredCapture(session, detected);
    return {
      text: this.confirmStructuredCaptureText(detected),
      providerLatencyMs: 0,
      toolResults: [],
      askedModelForTools: false,
      toolsUsed: false,
    };
  }

  private detectStructuredCaptureCandidate(
    transcript: string,
    session: SessionState,
    forcedField?: StructuredCaptureField,
  ): StructuredCaptureState | undefined {
    const context = this.getStructuredCaptureContext(transcript, session);
    const confirmed = this.getConfirmedDetails(session);

    if (forcedField === 'phone' || (!forcedField && context.phone)) {
      const phone = this.parseSpokenAustralianPhone(transcript);
      if (phone.ok) {
        if (!forcedField && confirmed.phone?.value === phone.e164) {
          return undefined;
        }

        return {
          field: 'phone',
          value: phone.e164 ?? '',
          display: this.spokenPhoneForConfirmation(phone.nationalDigits),
          rawTranscript: transcript,
          attempts: 0,
          createdAt: nowIso(),
        };
      }

      if (phone.incomplete && context.phone) {
        return undefined;
      }
    }

    if (
      forcedField === 'registration' ||
      (!forcedField && context.registration)
    ) {
      const registration = this.parseSpokenRegistration(transcript, context);
      if (registration) {
        if (
          !forcedField &&
          confirmed.registration?.value.toUpperCase() ===
            registration.toUpperCase()
        ) {
          return undefined;
        }

        return {
          field: 'registration',
          value: registration,
          display: this.spokenRegistrationForConfirmation(registration),
          rawTranscript: transcript,
          attempts: 0,
          createdAt: nowIso(),
        };
      }
    }

    return undefined;
  }

  private getStructuredCaptureContext(
    transcript: string,
    session: SessionState,
  ): { phone: boolean; registration: boolean } {
    const lastAssistant =
      [...session.history].reverse().find((item) => item.role === 'assistant')
        ?.text ?? '';
    const combined = `${lastAssistant} ${transcript}`.toLowerCase();

    return {
      phone: /\b(phone|mobile|number|contact number)\b/.test(combined),
      registration: /\b(rego|registration|plate|licen[cs]e plate)\b/.test(
        combined,
      ),
    };
  }

  private getStructuredCapture(
    session: SessionState,
  ): StructuredCaptureState | undefined {
    const capture = session.metadata?.structuredCapture;
    if (!this.isRecord(capture)) {
      return undefined;
    }

    if (
      (capture.field === 'phone' || capture.field === 'registration') &&
      typeof capture.value === 'string' &&
      typeof capture.display === 'string' &&
      typeof capture.rawTranscript === 'string'
    ) {
      return {
        field: capture.field,
        value: capture.value,
        display: capture.display,
        rawTranscript: capture.rawTranscript,
        attempts: typeof capture.attempts === 'number' ? capture.attempts : 0,
        createdAt:
          typeof capture.createdAt === 'string' ? capture.createdAt : nowIso(),
      };
    }

    return undefined;
  }

  private setStructuredCapture(
    session: SessionState,
    capture: StructuredCaptureState,
  ): void {
    session.metadata = {
      ...(session.metadata ?? {}),
      structuredCapture: capture,
    };
  }

  private clearStructuredCapture(session: SessionState): void {
    if (!session.metadata) {
      return;
    }

    const { structuredCapture: _structuredCapture, ...rest } = session.metadata;
    session.metadata = rest;
  }

  private confirmStructuredCaptureText(
    capture: StructuredCaptureState,
  ): string {
    return capture.field === 'phone'
      ? `I heard ${capture.display}. Is that correct?`
      : `I heard registration ${capture.display}. Is that correct?`;
  }

  private isAffirmative(text: string): boolean {
    return /\b(yes|yeah|yep|correct|right|that'?s right|that is right|exactly|confirmed|confirm)\b/i.test(
      text,
    );
  }

  private isNegative(text: string): boolean {
    return /\b(no|nope|nah|incorrect|wrong|not right|that'?s wrong|try again)\b/i.test(
      text,
    );
  }

  private async generateAfterTools(
    sessionId: string,
    turnId: string,
    task: TaskConfig,
    messages: ChatMessage[],
    assistantText: string,
    toolCalls: ToolCall[],
    emit: OrchestratorEmit,
  ): Promise<{
    text: string;
    providerLatencyMs: number;
    toolResults: NormalizedToolResult[];
  }> {
    const toolResults = await this.executeTools(
      sessionId,
      turnId,
      task,
      toolCalls,
      emit,
    );

    if (!this.isTurnCurrent(sessionId, turnId)) {
      throw new AppError(
        'TURN_INTERRUPTED',
        'Tool follow-up stopped because a newer turn interrupted this response.',
      );
    }

    const followupMessages = this.buildToolFollowupMessages(
      messages,
      assistantText,
      toolCalls,
      toolResults,
    );

    const final = await this.reasoning.generate({
      messages: followupMessages,
      temperature: 0.2,
    });

    if (!this.isTurnCurrent(sessionId, turnId)) {
      throw new AppError(
        'TURN_INTERRUPTED',
        'Tool follow-up stopped because a newer turn interrupted this response.',
      );
    }

    return {
      text: final.text,
      providerLatencyMs:
        final.latencyMs +
        toolResults.reduce((sum, item) => sum + item.latencyMs, 0),
      toolResults,
    };
  }

  private async executeTools(
    sessionId: string,
    turnId: string,
    task: TaskConfig,
    toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
    emit: OrchestratorEmit,
  ): Promise<NormalizedToolResult[]> {
    const results: NormalizedToolResult[] = [];

    for (const toolCall of toolCalls) {
      emit({
        type: 'tool.called',
        sessionId,
        timestamp: nowIso(),
        payload: { turnId, toolCall },
      });

      const result = await this.toolRuntime.execute(
        toolCall,
        { sessionId, turnId },
        task.allowedTools,
      );

      emit({
        type: 'tool.result',
        sessionId,
        timestamp: nowIso(),
        payload: { turnId, result },
      });
      results.push(result);
    }

    return results;
  }

  private buildToolFollowupMessages(
    originalMessages: ChatMessage[],
    assistantText: string,
    toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
    results: NormalizedToolResult[],
  ): ChatMessage[] {
    return [
      ...originalMessages,
      {
        role: 'assistant',
        content: assistantText,
        toolCalls,
      },
      ...results.map<ChatMessage>((result) => ({
        role: 'tool',
        name: result.name,
        toolCallId: result.toolCallId,
        content: JSON.stringify(
          result.ok ? result.output : { error: result.error },
        ),
      })),
      {
        role: 'user',
        content:
          'Use only the tool results above to answer the user. If a lookup says found:false, say you could not find that record and ask one short next question. If a tool failed, do not invent success; apologize briefly and ask to try again or offer escalation. Never say you found a customer, vehicle, booking, slot, or opening time unless a successful tool result proves it. Return only the final user-facing plain text response.',
      },
    ];
  }

  private withRuntimeRequiredTools(task: TaskConfig): TaskConfig {
    const looksLikeReceptionistTask =
      task.key === 'general_voice_assistant' ||
      /car service|workshop|receptionist/i.test(
        `${task.name} ${task.systemPrompt}`,
      );

    if (!looksLikeReceptionistTask) {
      return task;
    }

    const allowedTools = [
      ...new Set([...task.allowedTools, ...this.receptionistRuntimeTools]),
    ];

    if (allowedTools.length !== task.allowedTools.length) {
      this.logger.warn(
        `task.runtime_tools_added task=${task.key} added=${allowedTools.filter((tool) => !task.allowedTools.includes(tool)).join(',')}`,
      );
    }

    return {
      ...task,
      allowedTools,
    };
  }

  private buildDeterministicToolCalls(
    transcript: string,
    task: TaskConfig,
    session: SessionState,
  ): ToolCall[] {
    const lower = transcript.toLowerCase();
    const confirmed = this.getConfirmedDetails(session);
    const calls: ToolCall[] = [];

    if (this.isAllowedTool(task, 'get_workshop_info')) {
      const info = this.inferWorkshopInfoRequest(lower);
      if (info) {
        calls.push(this.createToolCall('get_workshop_info', { info }));
      }
    }

    if (
      calls.length === 0 &&
      this.isAllowedTool(task, 'check_booking_availability')
    ) {
      const transcriptContext = `${session.history.map((item) => item.text).join(' ')} ${transcript}`;
      const serviceType =
        confirmed.serviceType?.value ??
        this.inferServiceType(transcriptContext);
      const lastAssistant = [...session.history]
        .reverse()
        .find((item) => item.role === 'assistant')?.text;
      const answeredServiceQuestion =
        Boolean(serviceType) &&
        /\b(what type of service|what service|service do you need|which service)\b/i.test(
          lastAssistant ?? '',
        );
      const bookingIntent =
        /\b(book|booking|appointment|schedule|available|availability|slot)\b/.test(
          lower,
        );

      if (bookingIntent || answeredServiceQuestion) {
        calls.push(
          this.createToolCall(
            'check_booking_availability',
            this.compactObject({
              serviceType,
              date: this.inferDatePreference(transcriptContext),
              preferredTimeOfDay:
                this.inferPreferredTimeOfDay(transcriptContext),
              customerId: confirmed.customerId?.value,
              vehicleId: confirmed.vehicleId?.value,
            }),
          ),
        );
      }
    }

    if (calls.length > 0) {
      this.logger.log(
        `tool.route.deterministic calls=${calls.map((call) => call.name).join(',')}`,
      );
    }

    return calls;
  }

  private inferToolCallsFromAssistantText(
    text: string,
    task: TaskConfig,
    transcript: string,
    session: SessionState,
  ): ToolCall[] {
    const parsed = this.parseJsonObjectFromText(text);
    if (!parsed) {
      return [];
    }

    const explicitCalls = this.extractExplicitJsonToolCalls(parsed, task);
    if (explicitCalls.length > 0) {
      return explicitCalls;
    }

    if (this.isAllowedTool(task, 'check_booking_availability')) {
      const bookingArgs = this.inferBookingAvailabilityArgsFromJson(
        parsed,
        transcript,
        session,
      );
      if (bookingArgs) {
        return [this.createToolCall('check_booking_availability', bookingArgs)];
      }
    }

    return [];
  }

  private extractExplicitJsonToolCalls(
    parsed: Record<string, unknown>,
    task: TaskConfig,
  ): ToolCall[] {
    const toolCalls = Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
      : Array.isArray(parsed.toolCalls)
        ? parsed.toolCalls
        : undefined;

    if (toolCalls) {
      return toolCalls
        .map((call) => {
          if (!this.isRecord(call)) {
            return undefined;
          }

          const fn = this.isRecord(call.function) ? call.function : call;
          const name = typeof fn.name === 'string' ? fn.name : undefined;
          if (!name || !this.isAllowedTool(task, name)) {
            return undefined;
          }

          return this.createToolCall(
            name,
            this.normalizeJsonValue(fn.arguments ?? fn.args ?? {}),
            typeof call.id === 'string' ? call.id : undefined,
          );
        })
        .filter((call): call is ToolCall => Boolean(call));
    }

    const name =
      typeof parsed.tool === 'string'
        ? parsed.tool
        : typeof parsed.name === 'string'
          ? parsed.name
          : typeof parsed.toolName === 'string'
            ? parsed.toolName
            : undefined;

    if (!name || !this.isAllowedTool(task, name)) {
      return [];
    }

    return [
      this.createToolCall(
        name,
        this.normalizeJsonValue(
          parsed.arguments ??
            parsed.args ??
            parsed.input ??
            parsed.parameters ??
            {},
        ),
      ),
    ];
  }

  private inferBookingAvailabilityArgsFromJson(
    parsed: Record<string, unknown>,
    transcript: string,
    session: SessionState,
  ): Record<string, unknown> | undefined {
    const confirmed = this.getConfirmedDetails(session);
    const serviceType =
      confirmed.serviceType?.value ??
      this.inferServiceType(
        this.asString(parsed.serviceType ?? parsed.service_type) ?? transcript,
      );
    const hasBookingShape = [
      'serviceType',
      'service_type',
      'slotStart',
      'slot_start',
      'slotEnd',
      'slot_end',
      'vehicleId',
      'vehicle_id',
      'customerId',
      'customer_id',
    ].some((key) => key in parsed);

    if (!hasBookingShape && !serviceType) {
      return undefined;
    }

    const normalized = this.normalizeJsonValue(parsed);
    const record = this.isRecord(normalized) ? normalized : {};

    return this.compactObject({
      serviceType,
      date:
        this.asString(record.date) ??
        this.inferDatePreference(`${transcript} ${JSON.stringify(parsed)}`),
      preferredTimeOfDay: this.inferPreferredTimeOfDay(
        `${transcript} ${JSON.stringify(parsed)}`,
      ),
      customerId:
        this.asString(record.customerId ?? record.customer_id) ??
        confirmed.customerId?.value,
      vehicleId:
        this.asString(record.vehicleId ?? record.vehicle_id) ??
        confirmed.vehicleId?.value,
      slotStart: this.asString(record.slotStart ?? record.slot_start),
    });
  }

  private inferWorkshopInfoRequest(
    lower: string,
  ): 'hours' | 'today_hours' | 'location' | 'services' | 'all' | undefined {
    if (/\b(location|address|where are you|directions|parking)\b/.test(lower)) {
      return 'location';
    }

    if (/\b(services|service list|what do you do|what.*offer)\b/.test(lower)) {
      return 'services';
    }

    if (/\b(open today|today'?s hours|today hours)\b/.test(lower)) {
      return 'today_hours';
    }

    if (/\b(open|closed|hours|opening|closing|open tomorrow)\b/.test(lower)) {
      return 'hours';
    }

    return undefined;
  }

  private inferServiceType(text: string): string | undefined {
    const lower = text.toLowerCase();
    const matches: Array<[RegExp, string]> = [
      [/\boil\s+change\b/, 'oil_change'],
      [/\blogbook\b|\blog\s*book\b/, 'logbook_service'],
      [/\bbrake|brakes\b/, 'brakes'],
      [/\btyre|tyres|tire|tires\b/, 'tyres'],
      [/\bbattery\b/, 'battery'],
      [/\bdiagnostic|engine light|check engine\b/, 'engine_diagnostics'],
      [/\btransmission\b/, 'transmission'],
      [/\bsuspension\b/, 'suspension'],
      [/\binspection|roadworthy\b/, 'inspection'],
    ];

    return matches.find(([pattern]) => pattern.test(lower))?.[1];
  }

  private inferDatePreference(text: string): string | undefined {
    const lower = text.toLowerCase();
    const isoDate = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (isoDate) {
      return isoDate;
    }

    if (/\btomorrow\b/.test(lower)) {
      return 'tomorrow';
    }

    if (/\btoday\b/.test(lower)) {
      return 'today';
    }

    return undefined;
  }

  private inferPreferredTimeOfDay(
    text: string,
  ): 'morning' | 'afternoon' | 'any' {
    const lower = text.toLowerCase();
    if (/\bmorning\b/.test(lower)) {
      return 'morning';
    }

    if (/\bafternoon\b/.test(lower)) {
      return 'afternoon';
    }

    return 'any';
  }

  private parseSpokenAustralianPhone(text: string): {
    ok: boolean;
    e164?: string;
    nationalDigits?: string;
    incomplete?: boolean;
  } {
    const directCandidates = text.match(/(?:\+?61|0)[\d\s().-]{8,18}/g) ?? [];
    for (const candidate of directCandidates) {
      const result = this.validatePhoneDigits(candidate);
      if (result.ok) {
        return result;
      }
    }

    const digits = this.extractSpokenDigits(text).join('');
    const result = this.validatePhoneDigits(digits);
    if (result.ok) {
      return result;
    }

    return {
      ok: false,
      incomplete: digits.length >= 4 && digits.length < 10,
    };
  }

  private validatePhoneDigits(input: string): {
    ok: boolean;
    e164?: string;
    nationalDigits?: string;
  } {
    let digits = input.replace(/\D/g, '');

    if (digits.startsWith('61')) {
      digits = `0${digits.slice(2)}`;
    }

    if (
      digits.length !== 10 ||
      (!/^04\d{8}$/.test(digits) && !/^0[2378]\d{8}$/.test(digits))
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      e164: `+61${digits.slice(1)}`,
      nationalDigits: digits,
    };
  }

  private extractSpokenDigits(text: string): string[] {
    const tokens = text.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
    const digits: string[] = [];
    let repeatCount = 1;

    for (const token of tokens) {
      if (token === 'double') {
        repeatCount = 2;
        continue;
      }

      if (token === 'triple') {
        repeatCount = 3;
        continue;
      }

      const digit = this.spokenDigit(token);
      if (digit !== undefined) {
        for (let index = 0; index < repeatCount; index += 1) {
          digits.push(digit);
        }
        repeatCount = 1;
        continue;
      }

      if (/^\d+$/.test(token)) {
        for (const item of token) {
          digits.push(item);
        }
        repeatCount = 1;
        continue;
      }

      repeatCount = 1;
    }

    return digits;
  }

  private spokenDigit(token: string): string | undefined {
    const digits: Record<string, string> = {
      zero: '0',
      oh: '0',
      o: '0',
      one: '1',
      won: '1',
      two: '2',
      too: '2',
      to: '2',
      three: '3',
      tree: '3',
      four: '4',
      for: '4',
      five: '5',
      six: '6',
      seven: '7',
      eight: '8',
      ate: '8',
      nine: '9',
      niner: '9',
    };

    return digits[token];
  }

  private spokenPhoneForConfirmation(nationalDigits?: string): string {
    const words = [...(nationalDigits ?? '')].map((digit) =>
      this.digitWord(digit),
    );
    return [
      words.slice(0, 4).join(' '),
      words.slice(4, 7).join(' '),
      words.slice(7).join(' '),
    ]
      .filter(Boolean)
      .join(', ');
  }

  private digitWord(digit: string): string {
    const words: Record<string, string> = {
      '0': 'zero',
      '1': 'one',
      '2': 'two',
      '3': 'three',
      '4': 'four',
      '5': 'five',
      '6': 'six',
      '7': 'seven',
      '8': 'eight',
      '9': 'nine',
    };

    return words[digit] ?? digit;
  }

  private parseSpokenRegistration(
    text: string,
    context: { registration: boolean },
  ): string | undefined {
    const direct = this.extractRegistrationCandidate(text);
    if (direct) {
      return direct.replace(/[^a-z0-9]/gi, '').toUpperCase();
    }

    if (!context.registration) {
      return undefined;
    }

    const afterCue =
      text.split(/\b(?:rego|registration|plate|licen[cs]e plate)\b/i).pop() ??
      text;
    const tokens = afterCue.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
    const parts: string[] = [];
    let repeatCount = 1;

    for (const token of tokens) {
      if (token === 'double') {
        repeatCount = 2;
        continue;
      }

      if (token === 'triple') {
        repeatCount = 3;
        continue;
      }

      const part = this.spokenRegistrationPart(token);
      if (part) {
        for (let index = 0; index < repeatCount; index += 1) {
          parts.push(part);
        }
        repeatCount = 1;
        continue;
      }

      if (/^[a-z0-9]{2,8}$/i.test(token) && /\d/.test(token)) {
        parts.push(token.toUpperCase());
      }

      repeatCount = 1;
    }

    const registration = parts.join('').replace(/[^A-Z0-9]/g, '');
    return registration.length >= 2 && registration.length <= 10
      ? registration
      : undefined;
  }

  private spokenRegistrationPart(token: string): string | undefined {
    const digit = this.spokenDigit(token);
    if (digit !== undefined && token !== 'oh' && token !== 'o') {
      return digit;
    }

    const letters: Record<string, string> = {
      a: 'A',
      ay: 'A',
      b: 'B',
      be: 'B',
      bee: 'B',
      c: 'C',
      see: 'C',
      sea: 'C',
      d: 'D',
      dee: 'D',
      e: 'E',
      f: 'F',
      eff: 'F',
      g: 'G',
      gee: 'G',
      h: 'H',
      aitch: 'H',
      haitch: 'H',
      i: 'I',
      eye: 'I',
      j: 'J',
      jay: 'J',
      k: 'K',
      kay: 'K',
      l: 'L',
      el: 'L',
      m: 'M',
      em: 'M',
      n: 'N',
      en: 'N',
      o: 'O',
      oh: 'O',
      p: 'P',
      pea: 'P',
      q: 'Q',
      queue: 'Q',
      r: 'R',
      are: 'R',
      s: 'S',
      ess: 'S',
      t: 'T',
      tea: 'T',
      u: 'U',
      you: 'U',
      v: 'V',
      vee: 'V',
      w: 'W',
      doubleyou: 'W',
      x: 'X',
      ex: 'X',
      y: 'Y',
      why: 'Y',
      z: 'Z',
      zed: 'Z',
      zee: 'Z',
    };

    if (/^[a-z]$/i.test(token)) {
      return token.toUpperCase();
    }

    if (/^\d$/.test(token)) {
      return token;
    }

    return letters[token];
  }

  private spokenRegistrationForConfirmation(registration: string): string {
    return [...registration]
      .map((part) => (/^\d$/.test(part) ? this.digitWord(part) : part))
      .join(' ');
  }

  private extractRegistrationCandidate(text: string): string | undefined {
    const match = text.match(
      /\b(?:rego|registration|plate|licen[cs]e plate)\s*(?:is|number is|:)?\s*([a-z0-9 -]{2,10})\b/i,
    );
    return match?.[1]?.trim();
  }

  private enforceGroundedToolClaims(
    text: string,
    transcript: string,
    toolResults: NormalizedToolResult[],
  ): string {
    if (!text.trim()) {
      return text;
    }

    const lower = text.toLowerCase();
    const successfulTools = new Set(
      toolResults.filter((result) => result.ok).map((result) => result.name),
    );
    const failedTools = toolResults.filter((result) => !result.ok);

    if (failedTools.length > 0 && this.containsSystemSuccessClaim(lower)) {
      this.logger.warn(
        `response.grounded_claim_blocked reason=tool_failed tools=${failedTools.map((result) => result.name).join(',')}`,
      );
      return "I couldn't check that in the system just now. Could you repeat the detail, or I can take a message for the team.";
    }

    if (
      this.containsLookupSuccessClaim(lower) &&
      !this.hasAnySuccessfulTool(successfulTools, [
        'find_customer_by_phone',
        'find_vehicle_by_rego',
        'find_latest_booking_by_phone',
        'create_customer',
        'create_vehicle',
        'create_booking',
      ])
    ) {
      this.logger.warn('response.grounded_claim_blocked reason=lookup_claim');
      return this.hasRegistrationOrPhone(transcript)
        ? 'I need to check that in the system first. Could you repeat the phone number or registration once more?'
        : "I need to check that in the system first. What's the phone number or registration?";
    }

    if (
      this.containsBookingConfirmedClaim(lower) &&
      !successfulTools.has('create_booking')
    ) {
      this.logger.warn('response.grounded_claim_blocked reason=booking_claim');
      return 'I cannot confirm the booking until it is created in the system. Can I confirm the preferred time first?';
    }

    if (
      this.containsAvailabilityClaim(lower) &&
      !this.hasAnySuccessfulTool(successfulTools, [
        'check_booking_availability',
        'create_booking',
      ])
    ) {
      this.logger.warn(
        'response.grounded_claim_blocked reason=availability_claim',
      );
      return 'I need to check live availability before offering a time. What day works best?';
    }

    if (
      this.containsWorkshopHoursClaim(lower) &&
      !this.hasAnySuccessfulTool(successfulTools, [
        'get_workshop_info',
        'check_service_hours',
      ])
    ) {
      this.logger.warn('response.grounded_claim_blocked reason=hours_claim');
      return 'I need to check the workshop hours first. Which day would you like me to check?';
    }

    return text;
  }

  private containsSystemSuccessClaim(lower: string): boolean {
    return (
      this.containsLookupSuccessClaim(lower) ||
      this.containsBookingConfirmedClaim(lower) ||
      this.containsAvailabilityClaim(lower) ||
      this.containsWorkshopHoursClaim(lower)
    );
  }

  private containsLookupSuccessClaim(lower: string): boolean {
    return /\b(i('|’)ve|i have|we have|found|located|pulled up|matched|see) (your|the|a)?\s*(details|customer|profile|record|car|vehicle|booking)\b|\b(in our system|on file|your customer record|your vehicle record)\b/.test(
      lower,
    );
  }

  private containsBookingConfirmedClaim(lower: string): boolean {
    return /\b(booked|booking is confirmed|appointment is confirmed|appointment is set|you are booked|you’re booked|scheduled you|locked in)\b/.test(
      lower,
    );
  }

  private containsAvailabilityClaim(lower: string): boolean {
    return /\b(we have|there is|there are|i have|available|availability|slot|slots)\b.*\b(morning|afternoon|\d{1,2}(:\d{2})?\s*(am|pm)?|available|slot|slots)\b/.test(
      lower,
    );
  }

  private containsWorkshopHoursClaim(lower: string): boolean {
    return /\b(we are|we're|workshop is|shop is)\s+(open|closed)\b|\b(open from|open tomorrow|open today|closing at|closes at)\b/.test(
      lower,
    );
  }

  private hasAnySuccessfulTool(
    successfulTools: Set<string>,
    names: string[],
  ): boolean {
    return names.some((name) => successfulTools.has(name));
  }

  private hasRegistrationOrPhone(text: string): boolean {
    return Boolean(
      this.parseSpokenAustralianPhone(text).ok ||
      this.extractRegistrationCandidate(text),
    );
  }

  private parseJsonObjectFromText(
    text: string,
  ): Record<string, unknown> | undefined {
    const trimmed = text.trim();
    const candidate = trimmed.startsWith('{')
      ? trimmed
      : trimmed.match(/\{[\s\S]*\}/)?.[0];

    if (!candidate) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(candidate) as unknown;
      return this.isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private looksLikeJsonOnly(text: string): boolean {
    return /^\s*\{[\s\S]*\}\s*$/.test(text);
  }

  private normalizeJsonValue(value: unknown): unknown {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || /^(null|undefined)$/i.test(trimmed)) {
        return undefined;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return this.normalizeJsonValue(parsed);
      } catch {
        return trimmed;
      }
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => this.normalizeJsonValue(item))
        .filter((item) => item !== undefined);
    }

    if (this.isRecord(value)) {
      return this.compactObject(
        Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            this.normalizeJsonValue(item),
          ]),
        ),
      );
    }

    return value;
  }

  private compactObject(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private isAllowedTool(task: TaskConfig, name: string): boolean {
    return task.allowedTools.includes(name);
  }

  private createToolCall(name: string, args: unknown, id?: string): ToolCall {
    return {
      id: id ?? randomUUID(),
      name,
      arguments: args ?? {},
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private normalizeAssistantText(text: string, task: TaskConfig): string {
    const fallback = 'Done.';
    if (this.looksLikeJsonOnly(text)) {
      return 'I need a little more information to check that.';
    }

    const compact =
      this.sanitizeAssistantPlainText(
        (text || fallback).replaceAll(this.callEndMarker, ''),
      ) || fallback;
    return this.limitResponseForPhoneCall(
      compact,
      task.responsePolicy.maxResponseChars,
    );
  }

  private shouldEndCall(text: string): boolean {
    return text.includes(this.callEndMarker);
  }

  private isCallEndingUserText(text: string): boolean {
    return /\b(bye|goodbye|that'?s all|that is all|nothing else|no thanks|no thank you|all good|end the call|hang up)\b/i.test(
      text,
    );
  }

  private sanitizeAssistantPlainText(text: string): string {
    return text
      .replace(/\r/g, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(
        /\[(?:laugh|laughter|chuckle|cough|sigh|gasp|breath|sniff|clear throat|clears throat)\]/gi,
        ' ',
      )
      .replace(
        /\b(?:I am|I'm) (?:using|calling) (?:a )?(?:tool|function)[^.?!]*[.?!]?/gi,
        "I'll check that.",
      )
      .replace(
        /\b(?:tool|schema|prompt|websocket|memory store|validation error)\b/gi,
        '',
      )
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private limitResponseForPhoneCall(text: string, maxChars: number): string {
    const clipped = text.slice(0, maxChars).trim();
    const sentences = clipped.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clipped];

    if (sentences.length <= 2) {
      return clipped;
    }

    const questionIndex = sentences.findIndex(
      (sentence, index) => index < 3 && sentence.includes('?'),
    );
    const keepCount =
      questionIndex >= 0 ? questionIndex + 1 : clipped.length <= 260 ? 3 : 2;
    return sentences.slice(0, keepCount).join(' ').replace(/\s+/g, ' ').trim();
  }

  private shouldUseTools(transcript: string): boolean {
    const lower = transcript.toLowerCase();

    return (
      /\b(remember|memory|memor(y|ies)|recall|store this|save this)\b/.test(
        lower,
      ) ||
      /\b(time|date|today|timezone)\b/.test(lower) ||
      /\b(calculate|math|plus|minus|times|divided by)\b/.test(lower) ||
      /\d\s*[-+*/^]\s*\d/.test(lower) ||
      /\b(book|booking|appointment|schedule|available|availability|slot|tomorrow|morning|afternoon)\b/.test(
        lower,
      ) ||
      /\b(open|closed|hours|location|address|where are you|directions|parking|phone number)\b/.test(
        lower,
      ) ||
      /\b(name is|my name|phone|mobile|number is|rego|registration|plate|license plate|licence plate)\b/.test(
        lower,
      ) ||
      /\b(customer|email|booking reference|existing booking|latest booking|human|manager|complaint|urgent|emergency|escalate)\b/.test(
        lower,
      ) ||
      /\b(service|logbook|oil change|brake|brakes|tyre|tire|roadworthy|diagnostic|inspection|rego|vehicle|car)\b/.test(
        lower,
      )
    );
  }

  private extractSpeechChunks(
    text: string,
    cursor: number,
    force: boolean,
  ): Array<{ text: string; endIndex: number }> {
    const chunks: Array<{ text: string; endIndex: number }> = [];
    const flushRemainder = force;
    let offset = cursor;

    while (offset < text.length) {
      const remaining = text.slice(offset);
      const boundary = this.findSpeechBoundary(remaining, force);

      if (!boundary) {
        break;
      }

      const chunk = remaining.slice(0, boundary).replace(/\s+/g, ' ').trim();
      offset += boundary;

      if (chunk.length >= 2) {
        chunks.push({ text: chunk, endIndex: offset });
      }

      force = flushRemainder;
    }

    return chunks;
  }

  private findSpeechBoundary(text: string, force: boolean): number | undefined {
    const streamingAudio = this.tts.canStreamAudio();
    const gatewayOwnsSpeech = !this.tts.isEnabled();
    const minSentenceChars = gatewayOwnsSpeech ? 36 : streamingAudio ? 64 : 24;
    const preferredChars = gatewayOwnsSpeech ? 95 : streamingAudio ? 125 : 90;
    const maxChars = gatewayOwnsSpeech ? 145 : streamingAudio ? 200 : 140;
    const minSoftBoundaryChars = gatewayOwnsSpeech ? 45 : 50;

    for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
      const end = (match.index ?? 0) + 1;
      if (end >= minSentenceChars) {
        return end;
      }
    }

    if (text.length >= preferredChars) {
      const softBoundary = Math.max(
        text.lastIndexOf(',', maxChars),
        text.lastIndexOf(';', maxChars),
        text.lastIndexOf(':', maxChars),
      );

      if (softBoundary >= minSoftBoundaryChars) {
        return softBoundary + 1;
      }

      const lastSpace = text.lastIndexOf(' ', maxChars);
      if (lastSpace >= minSoftBoundaryChars) {
        return lastSpace;
      }

      return Math.min(text.length, maxChars);
    }

    if (!force) {
      return undefined;
    }

    const trimmed = text.trimEnd();
    return trimmed.length > 0 ? trimmed.length : undefined;
  }

  private async emitAssistantAudio(
    sessionId: string,
    turnId: string,
    text: string,
    emit: OrchestratorEmit,
  ): Promise<void> {
    if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
      return;
    }

    if (!this.tts.isEnabled()) {
      return;
    }

    if (!this.sessions.isAudioOutputEnabled(sessionId)) {
      this.logger.log(`tts.skip_disabled session=${sessionId} turn=${turnId}`);
      return;
    }

    const segments = this.tts.splitText(text);

    if (segments.length === 0) {
      return;
    }

    const metadata = this.tts.getMetadata();

    emit({
      type: 'assistant.audio.started',
      sessionId,
      timestamp: nowIso(),
      payload: {
        turnId,
        model: metadata.model,
        voice: metadata.voice,
        format: this.tts.canStreamAudio() ? 'pcm_s16le' : metadata.format,
        segmentCount: segments.length,
        streaming: this.tts.canStreamAudio(),
      },
    });

    try {
      if (this.tts.canStreamAudio()) {
        await this.emitAssistantAudioStream(sessionId, turnId, segments, emit);
      } else {
        await this.emitAssistantAudioBuffers(sessionId, turnId, segments, emit);
      }

      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        return;
      }

      emit({
        type: 'assistant.audio.ended',
        sessionId,
        timestamp: nowIso(),
        payload: {
          turnId,
          segmentCount: segments.length,
        },
      });
    } catch (error) {
      const payload = toErrorPayload(error);
      if (payload.code === 'TTS_STREAM_CANCELLED') {
        this.logger.log(
          `tts.stream.cancelled session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      emit({
        type: 'error',
        sessionId,
        timestamp: nowIso(),
        payload,
      });
      this.logger.warn(
        `tts.error session=${sessionId} turn=${turnId} code=${payload.code} message=${payload.message} details=${JSON.stringify(payload.details ?? {})}`,
      );
    }
  }

  private async emitAssistantAudioStream(
    sessionId: string,
    turnId: string,
    segments: ReturnType<TtsService['splitText']>,
    emit: OrchestratorEmit,
  ): Promise<void> {
    for (const segment of segments) {
      if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
        this.logger.log(
          `tts.stream.skip_stale session=${sessionId} turn=${turnId}`,
        );
        return;
      }

      await this.tts.streamSegment(segment, {
        onChunk: (chunk) => {
          if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
            this.logger.log(
              `tts.stream.chunk.skip_stale session=${sessionId} turn=${turnId}`,
            );
            throw new AppError(
              'TTS_STREAM_CANCELLED',
              'TTS stream cancelled because the turn is stale.',
            );
          }

          emit({
            type: 'assistant.audio.chunk',
            sessionId,
            timestamp: nowIso(),
            payload: {
              turnId,
              index: chunk.segmentIndex,
              total: chunk.segmentTotal,
              audioBase64: chunk.audio.toString('base64'),
              mimeType: chunk.mimeType,
              latencyMs: chunk.latencyMs,
              streaming: true,
              sampleRate: chunk.sampleRate,
              encoding: chunk.encoding,
              chunkIndex: chunk.chunkIndex,
            },
          });
        },
      });
    }
  }

  private async emitAssistantAudioBuffers(
    sessionId: string,
    turnId: string,
    segments: ReturnType<TtsService['splitText']>,
    emit: OrchestratorEmit,
  ): Promise<void> {
    for (const batch of this.batchSegments(segments)) {
      const pendingAudio = batch.map((segment) =>
        this.tts.synthesizeSegment(segment),
      );

      for (const promise of pendingAudio) {
        if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
          this.logger.log(`tts.skip_stale session=${sessionId} turn=${turnId}`);
          return;
        }

        const audio = await promise;

        if (!this.sessions.isCurrentTurn(sessionId, turnId)) {
          this.logger.log(
            `tts.chunk.skip_stale session=${sessionId} turn=${turnId}`,
          );
          return;
        }

        emit({
          type: 'assistant.audio.chunk',
          sessionId,
          timestamp: nowIso(),
          payload: {
            turnId,
            index: audio.segmentIndex,
            total: audio.segmentTotal,
            audioBase64: audio.audio.toString('base64'),
            mimeType: audio.mimeType,
            latencyMs: audio.latencyMs,
          },
        });
      }
    }
  }

  private batchSegments(
    segments: ReturnType<TtsService['splitText']>,
  ): Array<ReturnType<TtsService['splitText']>> {
    const concurrency = Math.min(this.tts.getConcurrency(), segments.length);
    const batches: Array<ReturnType<TtsService['splitText']>> = [];

    for (let index = 0; index < segments.length; index += concurrency) {
      batches.push(segments.slice(index, index + concurrency));
    }

    return batches;
  }
}
