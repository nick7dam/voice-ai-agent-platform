const vadConfig = {
  minSpeechThreshold: 0.025,
  noiseMultiplier: 3,
  silenceMs: 400,
  maxUtteranceMs: 8000,
  endThresholdPeakRatio: 0.35,
  minUtteranceMs: 380,
  minSpeechMs: 260,
  minAudioBytes: 2500,
  minPeakLevel: 0.035,
  minBargeInLevel: 0.025,
  bargeInThresholdMultiplier: 2.2,
  bargeInHoldMs: 180,
  bargeInMinPeakLevel: 0.05,
  bargeInMinSpeechMs: 320,
  assistantAudioGraceMs: 1500,
  audioFlushDelayMs: 900,
  chunkMs: 100,
  prerollMs: 500,
  partialTranscriptMs: 1200,
  partialTranscriptMinMs: 900,
  partialTranscriptMaxMs: 6000,
  partialTranscriptMinNewMs: 600,
};

const state = {
  socket: null,
  webrtcSignalSocket: null,
  webrtcPeerConnection: null,
  webrtcDataChannel: null,
  webrtcLocalStream: null,
  webrtcRemoteStream: null,
  webrtcBargeInContext: null,
  webrtcBargeInSource: null,
  webrtcBargeInAnalyser: null,
  webrtcBargeInFrame: null,
  webrtcBargeInLastAt: 0,
  webrtcBargeInCandidateMs: 0,
  webrtcBargeInMutedCandidate: false,
  webrtcDisconnectTimer: null,
  webrtcMuteTimer: null,
  webrtcActive: false,
  sessionId: null,
  liveStream: null,
  audioContext: null,
  analyser: null,
  vadFrame: null,
  captureProcessor: null,
  captureMute: null,
  prerollChunks: [],
  currentTurn: null,
  recordingStartedAt: 0,
  lastVoiceAt: 0,
  lastVadAt: 0,
  bargeInCandidateStartedAt: 0,
  noiseFloor: 0.006,
  assistantBusy: false,
  assistantAudioActive: false,
  assistantAudioTurnId: null,
  lastAssistantTurnId: null,
  lastAssistantAudioAt: 0,
  cancelledAudioTurnIds: new Set(),
  interruptSentForTurnIds: new Set(),
  streamActive: false,
  audioPlaybackEnabled: true,
  playbackContext: null,
  streamPlaybackNode: null,
  streamPlaybackReady: null,
  streamFlushTimer: null,
  streamAudioPlaying: false,
  streamAudioInputSampleRate: 24000,
  audioSources: new Set(),
  pendingAudioSchedules: 0,
  audioScheduleChain: Promise.resolve(),
  audioPlaybackNextTime: 0,
  audioPlaying: false,
  audioPlaybackToken: 0,
  pendingTurnEnd: false,
  stoppingRecorder: false,
  latestPartialTranscript: '',
  mimeType: 'audio/wav',
  sampleRate: 48000,
  pendingDebugText: '',
  latency: {
    sttMs: null,
    firstTokenMs: null,
    firstTextMs: null,
    firstAudioMs: null,
  },
};

const el = {
  wsUrl: document.querySelector('#wsUrl'),
  webrtcUrl: document.querySelector('#webrtcUrl'),
  taskKey: document.querySelector('#taskKey'),
  taskName: document.querySelector('#taskName'),
  systemPrompt: document.querySelector('#systemPrompt'),
  behaviorGuidelines: document.querySelector('#behaviorGuidelines'),
  allowedTools: document.querySelector('#allowedTools'),
  responseStyle: document.querySelector('#responseStyle'),
  maxResponseChars: document.querySelector('#maxResponseChars'),
  memoryEnabled: document.querySelector('#memoryEnabled'),
  maxFactsInPrompt: document.querySelector('#maxFactsInPrompt'),
  memoryWritePolicy: document.querySelector('#memoryWritePolicy'),
  loadTask: document.querySelector('#loadTask'),
  saveTask: document.querySelector('#saveTask'),
  resetTask: document.querySelector('#resetTask'),
  taskStatus: document.querySelector('#taskStatus'),
  connect: document.querySelector('#connect'),
  startSession: document.querySelector('#startSession'),
  startLive: document.querySelector('#startLive'),
  stopLive: document.querySelector('#stopLive'),
  startWebrtc: document.querySelector('#startWebrtc'),
  stopWebrtc: document.querySelector('#stopWebrtc'),
  sendText: document.querySelector('#sendText'),
  toggleAudio: document.querySelector('#toggleAudio'),
  endSession: document.querySelector('#endSession'),
  debugText: document.querySelector('#debugText'),
  status: document.querySelector('#status'),
  latencyStt: document.querySelector('#latencyStt'),
  latencyFirstToken: document.querySelector('#latencyFirstToken'),
  latencyFirstAudio: document.querySelector('#latencyFirstAudio'),
  micLevel: document.querySelector('#micLevel'),
  webrtcAudio: document.querySelector('#webrtcAudio'),
  chatHistory: document.querySelector('#chatHistory'),
  events: document.querySelector('#events'),
  assistant: document.querySelector('#assistant'),
};

function setStatus(text) {
  el.status.textContent = text;
}

function setTaskStatus(text) {
  el.taskStatus.textContent = text;
}

function formatLatency(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '--';
}

function updateLatencyMetrics(payload = {}) {
  if (payload.sttMs !== null && payload.sttMs !== undefined) {
    state.latency.sttMs = payload.sttMs;
  }
  if (payload.firstTokenMs !== null && payload.firstTokenMs !== undefined) {
    state.latency.firstTokenMs = payload.firstTokenMs;
  }
  if (payload.firstTextMs !== null && payload.firstTextMs !== undefined) {
    state.latency.firstTextMs = payload.firstTextMs;
  }
  if (payload.firstAudioMs !== null && payload.firstAudioMs !== undefined) {
    state.latency.firstAudioMs = payload.firstAudioMs;
  }

  el.latencyStt.textContent = formatLatency(state.latency.sttMs);
  el.latencyFirstToken.textContent = formatLatency(
    state.latency.firstTokenMs ?? state.latency.firstTextMs,
  );
  el.latencyFirstAudio.textContent = formatLatency(state.latency.firstAudioMs);
}

function resetLatencyMetrics() {
  state.latency = {
    sttMs: null,
    firstTokenMs: null,
    firstTextMs: null,
    firstAudioMs: null,
  };
  updateLatencyMetrics();
}

function linesToText(items) {
  return items.join('\n');
}

function textToList(text) {
  return text
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/realtime`;
}

function defaultWebRtcUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (window.location.protocol === 'https:') {
    return `${protocol}//${window.location.host}/voice`;
  }

  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:8004`;
}

function initializeWebSocketUrl() {
  if (el.wsUrl.value === 'ws://localhost:3000/realtime') {
    el.wsUrl.value = defaultWebSocketUrl();
  }

  if (el.webrtcUrl.value === 'ws://localhost:8004') {
    el.webrtcUrl.value = defaultWebRtcUrl();
  }
}

function logEvent(event) {
  el.events.textContent += `${new Date().toLocaleTimeString()} ${JSON.stringify(event, null, 2)}\n`;
  el.events.scrollTop = el.events.scrollHeight;
}

function logClientEvent(type, payload) {
  logEvent({
    type,
    timestamp: new Date().toISOString(),
    payload,
  });
}

function appendChatMessage(role, text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const item = document.createElement('div');
  item.className = `chat-message ${role}`;

  const label = document.createElement('span');
  label.className = 'chat-role';
  label.textContent = role === 'user' ? 'You' : 'Assistant';

  const body = document.createElement('span');
  body.textContent = trimmed;

  item.append(label, body);
  el.chatHistory.appendChild(item);
  el.chatHistory.scrollTop = el.chatHistory.scrollHeight;
}

function send(event) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  const message = { ...event };
  if (state.sessionId && !message.sessionId) {
    message.sessionId = state.sessionId;
  }
  state.socket.send(JSON.stringify(message));
}

function updateButtons() {
  const connected = state.socket?.readyState === WebSocket.OPEN;
  const hasSession = Boolean(state.sessionId);
  const webRtcActive = state.webrtcActive;
  el.startSession.disabled = !connected || hasSession;
  el.startLive.disabled = !hasSession || state.streamActive || webRtcActive;
  el.stopLive.disabled = !state.streamActive;
  el.startWebrtc.disabled = webRtcActive;
  el.stopWebrtc.disabled = !webRtcActive;
  el.sendText.disabled = !hasSession || webRtcActive;
  el.toggleAudio.disabled = !hasSession || webRtcActive;
  el.toggleAudio.textContent = state.audioPlaybackEnabled
    ? 'Audio on'
    : 'Audio off';
  el.endSession.disabled = !hasSession || webRtcActive;
}

function populateTaskForm(task) {
  el.taskKey.value = task.key;
  el.taskName.value = task.name;
  el.systemPrompt.value = task.systemPrompt;
  el.behaviorGuidelines.value = linesToText(task.behaviorGuidelines);
  el.allowedTools.value = linesToText(task.allowedTools);
  el.responseStyle.value = task.responsePolicy.style;
  el.maxResponseChars.value = String(task.responsePolicy.maxResponseChars);
  el.memoryEnabled.checked = task.memoryPolicy.enabled;
  el.maxFactsInPrompt.value = String(task.memoryPolicy.maxFactsInPrompt);
  el.memoryWritePolicy.value = task.memoryPolicy.writePolicy;
}

function readTaskForm() {
  return {
    key: el.taskKey.value.trim(),
    name: el.taskName.value.trim(),
    systemPrompt: el.systemPrompt.value.trim(),
    behaviorGuidelines: textToList(el.behaviorGuidelines.value),
    allowedTools: textToList(el.allowedTools.value),
    responsePolicy: {
      style: el.responseStyle.value.trim(),
      maxResponseChars: Number(el.maxResponseChars.value),
      plainTextOnly: true,
    },
    memoryPolicy: {
      enabled: el.memoryEnabled.checked,
      maxFactsInPrompt: Number(el.maxFactsInPrompt.value),
      writePolicy: el.memoryWritePolicy.value.trim(),
    },
  };
}

async function parseJsonResponse(response) {
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      body?.message ||
      body?.error ||
      `Request failed with HTTP ${response.status}`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }

  return body;
}

async function loadTaskConfig() {
  const taskKey = el.taskKey.value.trim();
  if (!taskKey) {
    setTaskStatus('Enter a task key first.');
    return;
  }

  setTaskStatus('Loading task...');
  const response = await fetch(`/tasks/${encodeURIComponent(taskKey)}`);
  const body = await parseJsonResponse(response);
  populateTaskForm(body.task);
  setTaskStatus(`Loaded ${body.task.key}`);
}

async function saveTaskConfig() {
  const task = readTaskForm();
  if (!task.key) {
    setTaskStatus('Enter a task key first.');
    return;
  }

  setTaskStatus('Saving task...');
  const response = await fetch(`/tasks/${encodeURIComponent(task.key)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(task),
  });
  const body = await parseJsonResponse(response);
  populateTaskForm(body.task);
  setTaskStatus('Task saved. The next turn will use this config.');
}

async function resetTaskConfig() {
  const taskKey = el.taskKey.value.trim();
  if (!taskKey) {
    setTaskStatus('Enter a task key first.');
    return;
  }

  setTaskStatus('Resetting task...');
  const response = await fetch(`/tasks/${encodeURIComponent(taskKey)}/reset`, {
    method: 'POST',
  });
  const body = await parseJsonResponse(response);
  populateTaskForm(body.task);
  setTaskStatus('Task reset to the built-in default.');
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function sendAudioBlob(blob, mimeType = state.mimeType) {
  if (!blob.size || !state.sessionId) {
    return;
  }

  send({
    type: 'audio.chunk',
    payload: {
      audioBase64: await blobToBase64(blob),
      mimeType,
      sampleRate: state.sampleRate,
    },
  });
}

async function sendPartialAudioBlob(blob, sequence, mimeType = state.mimeType) {
  if (!blob.size || !state.sessionId) {
    return;
  }

  send({
    type: 'audio.partial',
    payload: {
      audioBase64: await blobToBase64(blob),
      mimeType,
      sampleRate: state.sampleRate,
      sequence,
    },
  });
}

function getAnalyserLevel(analyser) {
  if (!analyser) {
    return 0;
  }

  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);

  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / samples.length);
}

function getMicLevel() {
  return getAnalyserLevel(state.analyser);
}

function updateMicMeter(level) {
  el.micLevel.style.width = `${Math.min(100, Math.round(level * 500))}%`;
}

function getCurrentAssistantTurnId() {
  return state.assistantAudioTurnId ?? state.lastAssistantTurnId;
}

function markAssistantAudioActivity(turnId) {
  state.lastAssistantAudioAt = performance.now();

  if (turnId) {
    state.lastAssistantTurnId = turnId;
  }
}

function hasRecentAssistantAudioActivity() {
  return (
    Boolean(state.lastAssistantTurnId) &&
    performance.now() - state.lastAssistantAudioAt <=
      vadConfig.assistantAudioGraceMs
  );
}

function hasAssistantVoiceOutput() {
  return (
    state.assistantAudioActive ||
    state.audioPlaying ||
    state.streamAudioPlaying ||
    state.pendingAudioSchedules > 0 ||
    state.audioSources.size > 0
  );
}

function hasInterruptibleAssistantOutput() {
  return (
    state.assistantBusy ||
    hasAssistantVoiceOutput() ||
    hasRecentAssistantAudioActivity()
  );
}

function isLikelyBargeIn(level, threshold) {
  return (
    level >= vadConfig.bargeInMinPeakLevel &&
    level >= vadConfig.minBargeInLevel &&
    level >= threshold * vadConfig.bargeInThresholdMultiplier
  );
}

function shouldStartUtterance(level, threshold, deltaMs) {
  if (!hasInterruptibleAssistantOutput()) {
    state.bargeInCandidateStartedAt = 0;
    return level >= threshold;
  }

  if (!isLikelyBargeIn(level, threshold)) {
    state.bargeInCandidateStartedAt = 0;
    return false;
  }

  state.bargeInCandidateStartedAt += deltaMs;
  return state.bargeInCandidateStartedAt >= vadConfig.bargeInHoldMs;
}

function isUtteranceSpeech(level, threshold, turn) {
  const peakAwareThreshold =
    turn.maxLevel > 0 ? turn.maxLevel * vadConfig.endThresholdPeakRatio : 0;
  return level >= Math.max(threshold, peakAwareThreshold);
}

function markAssistantAudioCancelled(turnId) {
  const activeTurnId = turnId ?? getCurrentAssistantTurnId();

  if (activeTurnId) {
    state.cancelledAudioTurnIds.add(activeTurnId);
  }

  const assistantTurnId = getCurrentAssistantTurnId();
  if (assistantTurnId) {
    state.cancelledAudioTurnIds.add(assistantTurnId);
  }
}

function stopAssistantAudio(options = {}) {
  clearPendingStreamFlush();

  if (options.cancelTurn) {
    markAssistantAudioCancelled(options.turnId);
  }

  const hadOutput = hasAssistantVoiceOutput();
  state.audioPlaybackToken += 1;
  state.pendingAudioSchedules = 0;
  state.audioScheduleChain = Promise.resolve();
  state.audioPlaybackNextTime = 0;
  state.streamAudioPlaying = false;

  if (state.streamPlaybackNode) {
    state.streamPlaybackNode.port.postMessage({ type: 'clear' });
  }

  for (const source of state.audioSources) {
    try {
      source.stop();
    } catch {
      // Source may already be stopped by the audio clock.
    }
  }
  state.audioSources.clear();

  state.audioPlaying = false;
  if (hadOutput) {
    state.prerollChunks = [];
    state.bargeInCandidateStartedAt = 0;
  }

  if (options.cancelTurn) {
    state.assistantAudioActive = false;
    state.assistantAudioTurnId = null;
  }
}

function sendSessionInterrupt(reason, turnId) {
  if (turnId && state.interruptSentForTurnIds.has(turnId)) {
    return true;
  }

  if (turnId) {
    state.interruptSentForTurnIds.add(turnId);
  }

  send({
    type: 'session.interrupt',
    payload: {
      reason,
    },
  });

  logClientEvent('client.interrupt.sent', {
    reason,
    turnId,
  });

  return true;
}

function interruptAssistantOutput(reason) {
  if (!hasInterruptibleAssistantOutput()) {
    return false;
  }

  const turnId = getCurrentAssistantTurnId();
  stopAssistantAudio({ cancelTurn: true, turnId });
  state.assistantBusy = false;

  return sendSessionInterrupt(reason, turnId);
}

function cancelAssistantAudioTurn(turnId, reason) {
  if (!turnId) {
    return;
  }

  state.cancelledAudioTurnIds.add(turnId);

  if (getCurrentAssistantTurnId() === turnId) {
    stopAssistantAudio({ cancelTurn: true, turnId });
  }

  sendSessionInterrupt(reason, turnId);
}

function resetAssistantOutputState(options = {}) {
  stopAssistantAudio({ cancelTurn: true });
  state.assistantBusy = false;
  state.assistantAudioActive = false;
  state.assistantAudioTurnId = null;
  state.lastAssistantTurnId = null;
  state.lastAssistantAudioAt = 0;

  if (options.clearCancelled !== false) {
    state.cancelledAudioTurnIds.clear();
    state.interruptSentForTurnIds.clear();
  }
}

function audioBase64ToArrayBuffer(audioBase64) {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function clearPendingStreamFlush() {
  if (!state.streamFlushTimer) {
    return;
  }

  window.clearTimeout(state.streamFlushTimer);
  state.streamFlushTimer = null;
}

function scheduleStreamFlush(turnId) {
  clearPendingStreamFlush();

  state.streamFlushTimer = window.setTimeout(() => {
    state.streamFlushTimer = null;

    if (
      state.cancelledAudioTurnIds.has(turnId) ||
      getCurrentAssistantTurnId() !== turnId
    ) {
      return;
    }

    state.streamPlaybackNode?.port.postMessage({ type: 'flush' });
  }, vadConfig.audioFlushDelayMs);
}

async function ensurePlaybackContext() {
  if (!state.playbackContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.playbackContext = new AudioContextClass({
      latencyHint: 'interactive',
    });
  }

  if (state.playbackContext.state === 'suspended') {
    await state.playbackContext.resume();
  }

  return state.playbackContext;
}

async function ensureStreamPlayback(sampleRate) {
  const context = await ensurePlaybackContext();

  if (!context.audioWorklet) {
    throw new Error('AudioWorklet is not available in this browser.');
  }

  if (!state.streamPlaybackReady) {
    state.streamPlaybackReady = context.audioWorklet.addModule(
      '/audio-player.worklet.js',
    );
  }

  await state.streamPlaybackReady;

  if (!state.streamPlaybackNode) {
    state.streamPlaybackNode = new AudioWorkletNode(
      context,
      'pcm-stream-player',
      {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      },
    );
    state.streamPlaybackNode.port.onmessage = (message) => {
      if (message.data?.type === 'drain') {
        state.streamAudioPlaying = false;
        state.audioPlaybackNextTime = 0;
        state.prerollChunks = [];
        state.bargeInCandidateStartedAt = 0;
      }
    };
    state.streamPlaybackNode.connect(context.destination);
  }

  if (state.streamAudioInputSampleRate !== sampleRate) {
    state.streamAudioInputSampleRate = sampleRate;
    state.streamPlaybackNode.port.postMessage({
      type: 'configure',
      inputSampleRate: sampleRate,
    });
  }

  return state.streamPlaybackNode;
}

function enqueueAssistantPcmAudio(payload) {
  clearPendingStreamFlush();
  markAssistantAudioActivity(payload.turnId);

  const sampleRate = Number(payload.sampleRate || 24000);
  const audioBuffer = audioBase64ToArrayBuffer(payload.audioBase64);
  const token = state.audioPlaybackToken;

  state.pendingAudioSchedules += 1;
  state.audioScheduleChain = state.audioScheduleChain
    .then(async () => {
      if (
        token !== state.audioPlaybackToken ||
        state.cancelledAudioTurnIds.has(payload.turnId)
      ) {
        return;
      }

      const node = await ensureStreamPlayback(sampleRate);

      if (
        token !== state.audioPlaybackToken ||
        state.cancelledAudioTurnIds.has(payload.turnId)
      ) {
        return;
      }

      state.streamAudioPlaying = true;
      markAssistantAudioActivity(payload.turnId);
      node.port.postMessage(
        {
          type: 'chunk',
          audio: audioBuffer,
          inputSampleRate: sampleRate,
          encoding: payload.encoding,
        },
        [audioBuffer],
      );
    })
    .catch((error) => {
      logClientEvent('client.audio.stream_failed', {
        message:
          error instanceof Error
            ? error.message
            : 'Audio stream playback failed',
      });
    })
    .finally(() => {
      state.pendingAudioSchedules = Math.max(
        0,
        state.pendingAudioSchedules - 1,
      );
    });

  return true;
}

function enqueueAssistantAudio(payload) {
  if (
    !state.audioPlaybackEnabled ||
    state.cancelledAudioTurnIds.has(payload.turnId)
  ) {
    return false;
  }

  if (
    state.assistantAudioTurnId &&
    payload.turnId !== state.assistantAudioTurnId
  ) {
    return false;
  }

  clearPendingStreamFlush();

  if (payload.streaming && payload.encoding === 'pcm_s16le') {
    return enqueueAssistantPcmAudio(payload);
  }

  const token = state.audioPlaybackToken;
  const audioBuffer = audioBase64ToArrayBuffer(payload.audioBase64);
  markAssistantAudioActivity(payload.turnId);
  state.pendingAudioSchedules += 1;
  state.audioScheduleChain = state.audioScheduleChain
    .then(() => scheduleAssistantAudio(audioBuffer, payload.turnId, token))
    .catch((error) => {
      state.pendingAudioSchedules = Math.max(
        0,
        state.pendingAudioSchedules - 1,
      );
      logClientEvent('client.audio.playback_failed', {
        message:
          error instanceof Error ? error.message : 'Audio scheduling failed',
      });
    });
  return true;
}

async function scheduleAssistantAudio(encodedAudio, turnId, token) {
  if (
    token !== state.audioPlaybackToken ||
    state.cancelledAudioTurnIds.has(turnId)
  ) {
    state.pendingAudioSchedules = Math.max(0, state.pendingAudioSchedules - 1);
    return;
  }

  const context = await ensurePlaybackContext();
  const decodedAudio = await context.decodeAudioData(encodedAudio.slice(0));

  if (
    token !== state.audioPlaybackToken ||
    state.cancelledAudioTurnIds.has(turnId)
  ) {
    state.pendingAudioSchedules = Math.max(0, state.pendingAudioSchedules - 1);
    return;
  }

  const source = context.createBufferSource();
  source.buffer = decodedAudio;
  source.connect(context.destination);

  const startAt = Math.max(
    context.currentTime + 0.04,
    state.audioPlaybackNextTime || 0,
  );
  state.audioPlaybackNextTime = startAt + decodedAudio.duration;
  state.audioPlaying = true;
  state.audioSources.add(source);
  state.pendingAudioSchedules = Math.max(0, state.pendingAudioSchedules - 1);

  source.onended = () => {
    state.audioSources.delete(source);

    if (token !== state.audioPlaybackToken) {
      return;
    }

    if (state.audioSources.size === 0 && state.pendingAudioSchedules === 0) {
      state.audioPlaying = false;
      state.audioPlaybackNextTime = 0;
      state.prerollChunks = [];
      state.bargeInCandidateStartedAt = 0;
    }
  };

  try {
    source.start(startAt);
  } catch (error) {
    state.audioSources.delete(source);
    state.audioPlaying = state.audioSources.size > 0;
    throw error;
  }
}

function getSpeechThreshold() {
  return Math.max(
    vadConfig.minSpeechThreshold,
    state.noiseFloor * vadConfig.noiseMultiplier,
  );
}

function updateNoiseFloor(level) {
  const threshold = getSpeechThreshold();
  if (state.currentTurn || level >= threshold) {
    return;
  }

  state.noiseFloor = state.noiseFloor * 0.94 + level * 0.06;
}

function wavByteLength(sampleCount) {
  return 44 + sampleCount * 2;
}

function rememberPcmChunk(samples) {
  if (!samples.length) {
    return;
  }

  const now = performance.now();
  const chunk = {
    samples,
    sampleCount: samples.length,
    capturedAt: now,
  };
  const cutoff = now - vadConfig.prerollMs;
  state.prerollChunks = state.prerollChunks
    .filter((item) => item.capturedAt >= cutoff)
    .concat(chunk);

  if (state.currentTurn) {
    state.currentTurn.chunks.push(samples);
    state.currentTurn.sampleCount += samples.length;
    state.currentTurn.audioBytes = wavByteLength(state.currentTurn.sampleCount);
  }
}

function createTurn(now, thresholdAtStart) {
  const startedDuringAssistantOutput = hasInterruptibleAssistantOutput();
  const preroll = startedDuringAssistantOutput
    ? []
    : state.prerollChunks.filter(
        (chunk) => now - chunk.capturedAt <= vadConfig.prerollMs,
      );
  const chunks = preroll.map((chunk) => chunk.samples);
  const preRollSampleCount = preroll.reduce(
    (total, chunk) => total + chunk.sampleCount,
    0,
  );

  return {
    chunks,
    sampleCount: preRollSampleCount,
    audioBytes: wavByteLength(preRollSampleCount),
    preRollBytes: preRollSampleCount * 2,
    startedAt: now,
    thresholdAtStart,
    speechMs: 0,
    maxLevel: 0,
    levelSum: 0,
    levelFrames: 0,
    startedDuringAssistantOutput,
    partialSequence: 0,
    lastPartialSentAt: 0,
    lastPartialSampleCount: 0,
  };
}

function startUtteranceRecorder(thresholdAtStart) {
  if (!state.streamActive || state.currentTurn || state.stoppingRecorder) {
    return;
  }

  const now = performance.now();
  state.currentTurn = createTurn(now, thresholdAtStart);
  const shouldInterruptAssistant =
    state.currentTurn.startedDuringAssistantOutput;
  state.pendingTurnEnd = false;
  state.stoppingRecorder = false;
  state.recordingStartedAt = now;
  state.lastVoiceAt = state.recordingStartedAt;
  state.latestPartialTranscript = '';

  if (shouldInterruptAssistant) {
    interruptAssistantOutput('barge_in_started');
  }

  send({
    type: 'audio.turn_start',
    payload: {
      mimeType: state.mimeType,
      sampleRate: state.sampleRate,
    },
  });

  setStatus('Listening: speech detected');
  updateButtons();
}

function waitForPcmCapture() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 80);
  });
}

async function stopUtteranceRecorder(sendTurnEnd) {
  if (!state.currentTurn || state.stoppingRecorder) {
    return;
  }

  const turn = state.currentTurn;
  state.stoppingRecorder = true;
  state.pendingTurnEnd = sendTurnEnd;

  try {
    await waitForPcmCapture();

    if (state.pendingTurnEnd && state.sessionId) {
      await finalizeUtterance(turn);
    }
  } finally {
    state.pendingTurnEnd = false;
    if (state.currentTurn === turn) {
      state.currentTurn = null;
    }
    state.stoppingRecorder = false;
    updateButtons();
  }
}

function evaluateUtterance(turn) {
  const minSpeechMs = turn.startedDuringAssistantOutput
    ? vadConfig.bargeInMinSpeechMs
    : vadConfig.minSpeechMs;
  const requiredPeak = Math.max(
    turn.startedDuringAssistantOutput
      ? vadConfig.bargeInMinPeakLevel
      : vadConfig.minPeakLevel,
    turn.thresholdAtStart * 1.15,
  );
  const reasons = [];

  if (turn.chunks.length === 0) {
    reasons.push('no_audio_chunks');
  }

  if (turn.audioBytes < vadConfig.minAudioBytes) {
    reasons.push('too_few_audio_bytes');
  }

  if (turn.speechMs < minSpeechMs) {
    reasons.push('speech_too_short');
  }

  if (turn.maxLevel < requiredPeak) {
    reasons.push('peak_too_low');
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    metrics: {
      audioBytes: turn.audioBytes,
      speechMs: Math.round(turn.speechMs),
      maxLevel: Number(turn.maxLevel.toFixed(4)),
      avgLevel: Number(
        (turn.levelFrames ? turn.levelSum / turn.levelFrames : 0).toFixed(4),
      ),
      preRollBytes: turn.preRollBytes,
      startedDuringAssistantOutput: turn.startedDuringAssistantOutput,
      thresholdAtStart: Number(turn.thresholdAtStart.toFixed(4)),
      requiredPeak: Number(requiredPeak.toFixed(4)),
      minSpeechMs,
    },
  };
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function encodeWav(chunks, sampleRate) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, pcm, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function selectRecentChunks(chunks, maxSamples) {
  const selected = [];
  let remaining = maxSamples;

  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index];

    if (chunk.length <= remaining) {
      selected.unshift(chunk);
      remaining -= chunk.length;
      continue;
    }

    selected.unshift(chunk.slice(chunk.length - remaining));
    remaining = 0;
  }

  return selected;
}

function maybeSendPartialTranscript(turn, now) {
  if (!state.sessionId || !state.streamActive) {
    return;
  }

  if (now - state.lastVoiceAt > 250) {
    return;
  }

  const durationMs = (turn.sampleCount / state.sampleRate) * 1000;
  if (durationMs < vadConfig.partialTranscriptMinMs) {
    return;
  }

  if (now - turn.lastPartialSentAt < vadConfig.partialTranscriptMs) {
    return;
  }

  const minNewSamples = Math.round(
    (state.sampleRate * vadConfig.partialTranscriptMinNewMs) / 1000,
  );
  if (turn.sampleCount - turn.lastPartialSampleCount < minNewSamples) {
    return;
  }

  const maxSamples = Math.round(
    (state.sampleRate * vadConfig.partialTranscriptMaxMs) / 1000,
  );
  const chunks = selectRecentChunks(turn.chunks, maxSamples);

  if (chunks.length === 0) {
    return;
  }

  turn.partialSequence += 1;
  turn.lastPartialSentAt = now;
  turn.lastPartialSampleCount = turn.sampleCount;

  void sendPartialAudioBlob(
    encodeWav(chunks, state.sampleRate),
    turn.partialSequence,
    'audio/wav',
  );
}

async function finalizeUtterance(turn) {
  const result = evaluateUtterance(turn);

  if (!result.accepted) {
    logClientEvent('client.audio.discarded', {
      reasons: result.reasons,
      metrics: result.metrics,
    });
    setStatus('Ignored noise/silence');
    return;
  }

  logClientEvent('client.audio.accepted', {
    metrics: result.metrics,
  });

  interruptAssistantOutput('accepted_user_utterance');

  setStatus('Sending utterance...');

  await sendAudioBlob(encodeWav(turn.chunks, state.sampleRate), 'audio/wav');

  send({ type: 'audio.turn_end', payload: {} });
  setStatus('Transcribing...');
}

function runVadLoop() {
  if (!state.streamActive) {
    return;
  }

  const level = getMicLevel();
  const now = performance.now();
  const deltaMs = state.lastVadAt
    ? Math.min(100, Math.max(0, now - state.lastVadAt))
    : 16;
  const speechThreshold = getSpeechThreshold();
  state.lastVadAt = now;

  updateMicMeter(level);
  updateNoiseFloor(level);

  const speechDetected = shouldStartUtterance(level, speechThreshold, deltaMs);

  if (speechDetected) {
    const startingNewUtterance = !state.currentTurn && !state.stoppingRecorder;
    if (startingNewUtterance) {
      startUtteranceRecorder(speechThreshold);
    }
  }

  if (state.currentTurn) {
    state.currentTurn.levelFrames += 1;
    state.currentTurn.levelSum += level;
    state.currentTurn.maxLevel = Math.max(state.currentTurn.maxLevel, level);

    if (isUtteranceSpeech(level, speechThreshold, state.currentTurn)) {
      state.lastVoiceAt = now;
      state.currentTurn.speechMs += deltaMs;
    }
  }

  if (state.currentTurn) {
    const silenceForMs = now - state.lastVoiceAt;
    const utteranceMs = now - state.recordingStartedAt;

    maybeSendPartialTranscript(state.currentTurn, now);

    if (
      (silenceForMs >= vadConfig.silenceMs &&
        utteranceMs >= vadConfig.minUtteranceMs) ||
      utteranceMs >= vadConfig.maxUtteranceMs
    ) {
      void stopUtteranceRecorder(true);
    }
  }

  state.vadFrame = requestAnimationFrame(runVadLoop);
}

function startPcmCapture(source) {
  if (!state.audioContext) {
    return;
  }

  const processor = state.audioContext.createScriptProcessor(1024, 1, 1);
  const mute = state.audioContext.createGain();
  mute.gain.value = 0;
  state.captureProcessor = processor;
  state.captureMute = mute;
  state.sampleRate = state.audioContext.sampleRate;
  state.mimeType = 'audio/wav';
  state.prerollChunks = [];

  processor.onaudioprocess = (event) => {
    rememberPcmChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(state.audioContext.destination);
}

function stopPcmCapture() {
  if (state.captureProcessor) {
    state.captureProcessor.disconnect();
    state.captureProcessor.onaudioprocess = null;
    state.captureProcessor = null;
  }

  if (state.captureMute) {
    state.captureMute.disconnect();
    state.captureMute = null;
  }

  state.prerollChunks = [];
}

async function startLiveMic() {
  state.liveStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 16000,
    },
  });

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  try {
    state.audioContext = new AudioContextClass({
      latencyHint: 'interactive',
      sampleRate: 16000,
    });
  } catch {
    state.audioContext = new AudioContextClass({
      latencyHint: 'interactive',
    });
  }
  const source = state.audioContext.createMediaStreamSource(state.liveStream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  source.connect(state.analyser);

  state.streamActive = true;
  state.lastVoiceAt = performance.now();
  state.lastVadAt = 0;
  startPcmCapture(source);

  send({
    type: 'audio.stream_start',
    payload: {
      mimeType: state.mimeType,
    },
  });

  setStatus('Listening...');
  updateButtons();
  runVadLoop();
}

async function stopLiveMic() {
  state.streamActive = false;

  if (state.vadFrame) {
    cancelAnimationFrame(state.vadFrame);
    state.vadFrame = null;
  }

  await stopUtteranceRecorder(true);
  stopPcmCapture();

  state.liveStream?.getTracks().forEach((track) => track.stop());
  state.liveStream = null;

  if (state.audioContext) {
    await state.audioContext.close();
    state.audioContext = null;
  }

  state.analyser = null;
  updateMicMeter(0);
  send({ type: 'audio.stream_stop', payload: {} });
  setStatus('Live mic stopped');
  updateButtons();
}

function waitForIceGatheringComplete(peerConnection) {
  if (peerConnection.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 5000);
    const onStateChange = () => {
      if (peerConnection.iceGatheringState === 'complete') {
        window.clearTimeout(timeout);
        peerConnection.removeEventListener(
          'icegatheringstatechange',
          onStateChange,
        );
        resolve();
      }
    };
    peerConnection.addEventListener('icegatheringstatechange', onStateChange);
  });
}

function clearWebRtcDisconnectTimer() {
  if (!state.webrtcDisconnectTimer) {
    return;
  }

  window.clearTimeout(state.webrtcDisconnectTimer);
  state.webrtcDisconnectTimer = null;
}

function setWebRtcRemoteAudioEnabled(enabled) {
  state.webrtcRemoteStream
    ?.getAudioTracks()
    .forEach((track) => {
      track.enabled = enabled;
    });
}

function unmuteWebRtcAudio() {
  if (state.webrtcMuteTimer) {
    window.clearTimeout(state.webrtcMuteTimer);
    state.webrtcMuteTimer = null;
  }

  setWebRtcRemoteAudioEnabled(true);
  el.webrtcAudio.muted = false;
  if (el.webrtcAudio.srcObject) {
    void el.webrtcAudio.play().catch(() => undefined);
  }
}

function muteWebRtcAudioUntilNextAssistant() {
  if (state.webrtcMuteTimer) {
    window.clearTimeout(state.webrtcMuteTimer);
    state.webrtcMuteTimer = null;
  }

  setWebRtcRemoteAudioEnabled(false);
  el.webrtcAudio.muted = true;
  el.webrtcAudio.pause();
}

function sendWebRtcInterrupt(reason, turnId) {
  if (turnId && state.interruptSentForTurnIds.has(turnId)) {
    return true;
  }

  const message = JSON.stringify({ type: 'interrupt', reason });

  if (state.webrtcDataChannel?.readyState === 'open') {
    state.webrtcDataChannel.send(message);
  } else if (state.webrtcSignalSocket?.readyState === WebSocket.OPEN) {
    state.webrtcSignalSocket.send(message);
  } else {
    return false;
  }

  if (turnId) {
    state.interruptSentForTurnIds.add(turnId);
  }

  logClientEvent('client.webrtc.interrupt.sent', { reason, turnId });
  return true;
}

function clearWebRtcAssistantPlayback() {
  const turnId = getCurrentAssistantTurnId();
  markAssistantAudioCancelled(turnId);
  state.assistantBusy = false;
  state.assistantAudioActive = false;
  state.assistantAudioTurnId = null;
  muteWebRtcAudioUntilNextAssistant();
  return turnId;
}

function interruptWebRtcAssistantOutput(reason) {
  if (!state.webrtcActive || !hasInterruptibleAssistantOutput()) {
    return false;
  }

  const turnId = clearWebRtcAssistantPlayback();
  return sendWebRtcInterrupt(reason, turnId);
}

function runWebRtcBargeInLoop() {
  if (!state.webrtcActive || !state.webrtcBargeInAnalyser) {
    return;
  }

  const level = getAnalyserLevel(state.webrtcBargeInAnalyser);
  const now = performance.now();
  const deltaMs = state.webrtcBargeInLastAt
    ? Math.min(100, Math.max(0, now - state.webrtcBargeInLastAt))
    : 16;
  const threshold = getSpeechThreshold();
  const assistantOutputActive = hasInterruptibleAssistantOutput();
  state.webrtcBargeInLastAt = now;

  updateMicMeter(level);

  if (!assistantOutputActive) {
    updateNoiseFloor(level);
    state.webrtcBargeInCandidateMs = 0;
    state.webrtcBargeInMutedCandidate = false;
    state.webrtcBargeInFrame = requestAnimationFrame(runWebRtcBargeInLoop);
    return;
  }

  if (isLikelyBargeIn(level, threshold)) {
    state.webrtcBargeInCandidateMs += deltaMs;

    if (
      state.webrtcBargeInCandidateMs >= 60 &&
      !state.webrtcBargeInMutedCandidate
    ) {
      muteWebRtcAudioUntilNextAssistant();
      state.webrtcBargeInMutedCandidate = true;
    }

    if (state.webrtcBargeInCandidateMs >= 120) {
      interruptWebRtcAssistantOutput('client_local_barge_in');
      state.webrtcBargeInCandidateMs = 0;
    }
  } else {
    if (state.webrtcBargeInMutedCandidate) {
      unmuteWebRtcAudio();
    }
    state.webrtcBargeInCandidateMs = 0;
    state.webrtcBargeInMutedCandidate = false;
  }

  state.webrtcBargeInFrame = requestAnimationFrame(runWebRtcBargeInLoop);
}

async function startWebRtcBargeInMonitor(localStream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass({ latencyHint: 'interactive' });
  const source = context.createMediaStreamSource(localStream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  state.webrtcBargeInContext = context;
  state.webrtcBargeInSource = source;
  state.webrtcBargeInAnalyser = analyser;
  state.webrtcBargeInLastAt = 0;
  state.webrtcBargeInCandidateMs = 0;
  state.webrtcBargeInMutedCandidate = false;
  runWebRtcBargeInLoop();
}

async function stopWebRtcBargeInMonitor() {
  if (state.webrtcBargeInFrame) {
    cancelAnimationFrame(state.webrtcBargeInFrame);
    state.webrtcBargeInFrame = null;
  }

  state.webrtcBargeInSource?.disconnect();
  state.webrtcBargeInSource = null;
  state.webrtcBargeInAnalyser = null;
  state.webrtcBargeInCandidateMs = 0;
  state.webrtcBargeInMutedCandidate = false;

  if (state.webrtcBargeInContext) {
    await state.webrtcBargeInContext.close();
    state.webrtcBargeInContext = null;
  }

  updateMicMeter(0);
}

function handleWebRtcGatewayEvent(event) {
  logEvent(event);

  if (event.type === 'session.started') {
    state.sessionId = event.payload.sessionId;
    el.chatHistory.textContent = '';
    el.assistant.textContent = '';
    resetLatencyMetrics();
    setStatus(`WebRTC session ${state.sessionId}`);
  }

  if (event.type === 'gateway.peer.state') {
    setStatus(`WebRTC ${event.payload.state}`);
  }

  if (event.type === 'gateway.greeting') {
    appendChatMessage('assistant', event.payload.text || '');
    el.assistant.textContent = event.payload.text || '';
    setStatus('WebRTC greeting...');
  }

  if (event.type === 'gateway.speech.started') {
    if (event.payload?.startedDuringAssistant) {
      clearWebRtcAssistantPlayback();
    }
    setStatus('WebRTC heard speech');
  }

  if (event.type === 'gateway.speech.discarded') {
    setStatus('WebRTC ignored noise/silence');
  }

  if (event.type === 'gateway.transcription.started') {
    resetLatencyMetrics();
    setStatus('WebRTC transcribing...');
  }

  if (event.type === 'reasoning.started') {
    state.assistantBusy = true;
    state.lastAssistantTurnId = event.payload.turnId;
    setStatus('WebRTC thinking...');
  }

  if (event.type === 'reasoning.first_token') {
    updateLatencyMetrics({ firstTokenMs: event.payload.latencyMs });
  }

  if (event.type === 'gateway.latency.updated') {
    updateLatencyMetrics(event.payload);
  }

  if (event.type === 'gateway.transcription.empty') {
    setStatus('WebRTC did not catch that');
  }

  if (event.type === 'gateway.tts.started') {
    state.assistantAudioActive = true;
    state.assistantAudioTurnId = event.payload.turnId;
    markAssistantAudioActivity(event.payload.turnId);
    unmuteWebRtcAudio();
    setStatus('WebRTC speaking...');
  }

  if (event.type === 'gateway.tts.ended') {
    state.assistantAudioActive = false;
    state.assistantAudioTurnId = null;
    setStatus('WebRTC listening...');
  }

  if (event.type === 'gateway.audio.cleared') {
    state.assistantBusy = false;
    state.assistantAudioActive = false;
    state.assistantAudioTurnId = null;
    muteWebRtcAudioUntilNextAssistant();
    setStatus('WebRTC interrupted');
  }

  if (event.type === 'transcript.final') {
    appendChatMessage('user', event.payload.text || '');
    setStatus(`Heard: ${event.payload.text || '(empty)'}`);
  }

  if (event.type === 'assistant.response') {
    state.assistantBusy = false;
    appendChatMessage('assistant', event.payload.text || '');
    el.assistant.textContent = event.payload.text || '';
    setStatus('WebRTC listening...');
  }

  if (event.type === 'session.end_requested') {
    setStatus('Wrapping up the call...');
  }

  if (event.type === 'gateway.call.ended' || event.type === 'session.ended') {
    setStatus('Call ended');
    void stopWebRtcVoice({
      notifyGateway: false,
      statusText: 'Call ended. Start WebRTC voice to begin a new call.',
    });
  }

  if (event.type === 'session.interrupted') {
    clearWebRtcAssistantPlayback();
    setStatus('WebRTC interrupted');
  }

  if (event.type === 'gateway.error' || event.type === 'error') {
    const payload = event.payload || {};
    setStatus(`${payload.code || event.type}: ${payload.message || 'error'}`);
  }

  updateButtons();
}

function handleWebRtcEnvelope(message) {
  const envelope = JSON.parse(message.data || message);

  if (envelope.type === 'event') {
    handleWebRtcGatewayEvent(envelope.event);
    return envelope;
  }

  logClientEvent('webrtc.signaling', envelope);
  if (envelope.type === 'call.ended') {
    void stopWebRtcVoice({
      notifyGateway: false,
      statusText: 'Call ended. Start WebRTC voice to begin a new call.',
    });
  }
  return envelope;
}

function logWebRtcSetup(step, payload = {}) {
  logClientEvent('webrtc.setup', { step, ...payload });
}

function getWebRtcErrorMessage(error, fallback) {
  if (!(error instanceof Error)) {
    return fallback;
  }

  if (
    error.name === 'NotAllowedError' ||
    error.name === 'PermissionDeniedError'
  ) {
    return 'Microphone permission was denied. Allow mic access and start WebRTC voice again.';
  }

  if (
    error.name === 'NotFoundError' ||
    error.name === 'DevicesNotFoundError'
  ) {
    return 'No microphone was found by the browser.';
  }

  if (error.name === 'NotReadableError') {
    return 'The browser could not read the microphone. Another app may be using it.';
  }

  return error.message || fallback;
}

async function startWebRtcVoice() {
  if (state.webrtcActive) {
    return;
  }

  state.webrtcActive = true;
  state.interruptSentForTurnIds.clear();
  state.cancelledAudioTurnIds.clear();
  setStatus('Connecting WebRTC gateway...');
  updateButtons();

  const signalSocket = new WebSocket(el.webrtcUrl.value.trim());
  state.webrtcSignalSocket = signalSocket;

  let readyResolve;
  let readyReject;
  let answerResolve;
  let answerReject;
  const readyWait = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    window.setTimeout(
      () => reject(new Error('Timed out waiting for WebRTC gateway ready.')),
      10000,
    );
  });
  let answerTimer = null;
  const answerWait = new Promise((resolve, reject) => {
    answerResolve = resolve;
    answerReject = reject;
  });
  const startAnswerTimeout = () => {
    if (answerTimer) {
      window.clearTimeout(answerTimer);
    }
    answerTimer = window.setTimeout(
      () => answerReject?.(new Error('Timed out waiting for WebRTC answer.')),
      30000,
    );
  };

  signalSocket.addEventListener('message', (message) => {
    const envelope = handleWebRtcEnvelope(message);

    if (envelope.type === 'ready') {
      readyResolve(envelope);
    }

    if (envelope.type === 'answer') {
      if (answerTimer) {
        window.clearTimeout(answerTimer);
        answerTimer = null;
      }
      answerResolve(envelope);
    }

    if (envelope.type === 'error') {
      const message = envelope.message || 'WebRTC gateway error';
      setStatus(`WebRTC gateway error: ${message}`);
      readyReject?.(new Error(message));
      answerReject?.(new Error(message));
    }
  });

  signalSocket.addEventListener('close', (event) => {
    if (answerTimer) {
      window.clearTimeout(answerTimer);
      answerTimer = null;
    }
    const reason = event.reason
      ? ` ${event.reason}`
      : event.wasClean
        ? ''
        : ' unexpectedly';
    const message = `WebRTC signaling closed${reason} code=${event.code}`;
    logClientEvent('webrtc.signaling.closed', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    readyReject?.(new Error(message));
    answerReject?.(new Error(message));

    if (state.webrtcActive) {
      setStatus(message);
      void stopWebRtcVoice({ notifyGateway: false });
    }
  });

  await new Promise((resolve, reject) => {
    signalSocket.addEventListener('open', resolve, { once: true });
    signalSocket.addEventListener('error', reject, { once: true });
  });
  logWebRtcSetup('signaling.open', { url: el.webrtcUrl.value.trim() });

  signalSocket.send(
    JSON.stringify({
      type: 'start',
      taskKey: el.taskKey.value.trim() || 'general_voice_assistant',
    }),
  );
  logWebRtcSetup('session.start.sent');
  const gatewayReady = await readyWait;
  logWebRtcSetup('gateway.ready', {
    iceServers: Array.isArray(gatewayReady.iceServers)
      ? gatewayReady.iceServers.length
      : 0,
    iceTransportPolicy: gatewayReady.iceTransportPolicy || 'all',
  });

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Browser microphone access is unavailable. Open the UI through http://127.0.0.1:3000, localhost, or HTTPS.',
    );
  }

  let localStream;
  try {
    logWebRtcSetup('microphone.requested');
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (error) {
    throw new Error(
      getWebRtcErrorMessage(error, 'Could not access the microphone.'),
    );
  }
  logWebRtcSetup('microphone.ready', {
    tracks: localStream.getAudioTracks().length,
  });
  state.webrtcLocalStream = localStream;
  await startWebRtcBargeInMonitor(localStream);
  logWebRtcSetup('local_barge_in_monitor.ready');

  const peerConnection = new RTCPeerConnection({
    iceServers: Array.isArray(gatewayReady.iceServers)
      ? gatewayReady.iceServers
      : [],
    iceTransportPolicy:
      gatewayReady.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  });
  logWebRtcSetup('peer.created');
  state.webrtcPeerConnection = peerConnection;

  const dataChannel = peerConnection.createDataChannel('events');
  state.webrtcDataChannel = dataChannel;
  dataChannel.addEventListener('message', (message) => {
    handleWebRtcEnvelope(message);
  });

  const remoteStream = new MediaStream();
  state.webrtcRemoteStream = remoteStream;
  el.webrtcAudio.srcObject = remoteStream;

  peerConnection.addEventListener('track', (event) => {
    remoteStream.addTrack(event.track);
    void el.webrtcAudio.play().catch(() => undefined);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    const connectionState = peerConnection.connectionState;
    setStatus(`WebRTC ${connectionState}`);

    if (connectionState === 'connected') {
      clearWebRtcDisconnectTimer();
      return;
    }

    if (connectionState === 'disconnected') {
      clearWebRtcDisconnectTimer();
      state.webrtcDisconnectTimer = window.setTimeout(() => {
        if (peerConnection.connectionState === 'disconnected') {
          void stopWebRtcVoice({ notifyGateway: false });
        }
      }, 3000);
      return;
    }

    if (['failed', 'closed'].includes(connectionState)) {
      clearWebRtcDisconnectTimer();
      void stopWebRtcVoice({ notifyGateway: false });
    }
  });

  for (const track of localStream.getTracks()) {
    peerConnection.addTrack(track, localStream);
  }
  logWebRtcSetup('tracks.added', { tracks: localStream.getTracks().length });

  const offer = await peerConnection.createOffer();
  logWebRtcSetup('offer.created');
  await peerConnection.setLocalDescription(offer);
  logWebRtcSetup('local_description.set');
  await waitForIceGatheringComplete(peerConnection);
  logWebRtcSetup('ice_gathering.done', {
    state: peerConnection.iceGatheringState,
  });

  signalSocket.send(
    JSON.stringify({
      type: 'offer',
      sdp: peerConnection.localDescription.sdp,
      sdpType: peerConnection.localDescription.type,
    }),
  );
  logWebRtcSetup('offer.sent');
  startAnswerTimeout();

  const answer = await answerWait;
  logWebRtcSetup('answer.received');
  await peerConnection.setRemoteDescription(
    new RTCSessionDescription({
      type: answer.sdpType,
      sdp: answer.sdp,
    }),
  );
  logWebRtcSetup('remote_description.set');

  setStatus('WebRTC listening...');
  updateButtons();
}

async function stopWebRtcVoice(options = {}) {
  const notifyGateway = options.notifyGateway !== false;
  const statusText = options.statusText || 'WebRTC stopped';

  state.webrtcActive = false;
  clearWebRtcDisconnectTimer();
  await stopWebRtcBargeInMonitor();
  unmuteWebRtcAudio();

  if (
    notifyGateway &&
    state.webrtcSignalSocket?.readyState === WebSocket.OPEN
  ) {
    state.webrtcSignalSocket.send(JSON.stringify({ type: 'stop' }));
  }

  state.webrtcDataChannel?.close();
  state.webrtcDataChannel = null;

  state.webrtcPeerConnection?.close();
  state.webrtcPeerConnection = null;

  state.webrtcLocalStream?.getTracks().forEach((track) => track.stop());
  state.webrtcLocalStream = null;

  state.webrtcRemoteStream?.getTracks().forEach((track) => track.stop());
  state.webrtcRemoteStream = null;
  el.webrtcAudio.srcObject = null;

  state.webrtcSignalSocket?.close();
  state.webrtcSignalSocket = null;

  state.sessionId = null;
  setStatus(statusText);
  updateButtons();
}

el.loadTask.addEventListener('click', () => {
  void loadTaskConfig().catch((error) => {
    setTaskStatus(
      error instanceof Error ? error.message : 'Could not load task',
    );
  });
});

el.saveTask.addEventListener('click', () => {
  void saveTaskConfig().catch((error) => {
    setTaskStatus(
      error instanceof Error ? error.message : 'Could not save task',
    );
  });
});

el.resetTask.addEventListener('click', () => {
  void resetTaskConfig().catch((error) => {
    setTaskStatus(
      error instanceof Error ? error.message : 'Could not reset task',
    );
  });
});

el.taskKey.addEventListener('change', () => {
  void loadTaskConfig().catch((error) => {
    setTaskStatus(
      error instanceof Error ? error.message : 'Could not load task',
    );
  });
});

void loadTaskConfig().catch((error) => {
  setTaskStatus(error instanceof Error ? error.message : 'Could not load task');
});

initializeWebSocketUrl();

el.connect.addEventListener('click', () => {
  state.socket = new WebSocket(el.wsUrl.value);
  setStatus('Connecting...');

  state.socket.addEventListener('open', () => {
    setStatus('Connected');
    updateButtons();
  });

  state.socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    logEvent(event);

    if (event.type === 'session.started') {
      state.sessionId = event.payload.sessionId;
      el.chatHistory.textContent = '';
      el.assistant.textContent = '';
      resetAssistantOutputState();
      resetLatencyMetrics();
      setStatus(`Session ${state.sessionId}`);
    }

    if (event.type === 'reasoning.started') {
      state.assistantBusy = true;
      state.lastAssistantTurnId = event.payload.turnId;
      setStatus('Thinking...');
    }

    if (event.type === 'session.interrupted') {
      resetAssistantOutputState({ clearCancelled: false });
      setStatus('Interrupted');
    }

    if (event.type === 'session.end_requested') {
      setStatus('Assistant marked the call complete');
    }

    if (event.type === 'session.audio_output.updated') {
      state.audioPlaybackEnabled = event.payload.enabled;
      if (!state.audioPlaybackEnabled) {
        stopAssistantAudio({ cancelTurn: true });
      }
    }

    if (event.type === 'transcript.final') {
      const transcript = event.payload.text || '';
      resetLatencyMetrics();
      updateLatencyMetrics({ sttMs: event.payload.latencyMs });
      if (transcript !== state.pendingDebugText) {
        appendChatMessage('user', transcript);
      }
      state.pendingDebugText = '';
      state.latestPartialTranscript = '';
      setStatus(`Heard: ${event.payload.text || '(empty)'}`);
    }

    if (event.type === 'reasoning.first_token') {
      updateLatencyMetrics({ firstTokenMs: event.payload.latencyMs });
    }

    if (event.type === 'transcript.partial') {
      const transcript = event.payload.text || '';
      if (transcript && transcript !== state.latestPartialTranscript) {
        state.latestPartialTranscript = transcript;
        setStatus(`Hearing: ${transcript}`);
      }
    }

    if (event.type === 'assistant.response') {
      state.assistantBusy = false;
      state.lastAssistantTurnId = event.payload.turnId;
      appendChatMessage('assistant', event.payload.text || '');
      el.assistant.textContent = event.payload.text;
      setStatus(state.streamActive ? 'Listening...' : 'Response received');
    }

    if (event.type === 'assistant.audio.started') {
      if (state.cancelledAudioTurnIds.has(event.payload.turnId)) {
        return;
      }

      clearPendingStreamFlush();

      if (state.currentTurn || state.stoppingRecorder) {
        cancelAssistantAudioTurn(
          event.payload.turnId,
          'user_speaking_before_audio_playback',
        );
        return;
      }

      if (
        state.assistantAudioTurnId &&
        state.assistantAudioTurnId !== event.payload.turnId
      ) {
        stopAssistantAudio({ cancelTurn: true });
      }

      state.assistantAudioActive = true;
      state.assistantAudioTurnId = event.payload.turnId;
      markAssistantAudioActivity(event.payload.turnId);
      state.prerollChunks = [];
      state.bargeInCandidateStartedAt = 0;
      setStatus('Preparing voice...');
    }

    if (event.type === 'assistant.audio.chunk') {
      if (enqueueAssistantAudio(event.payload)) {
        setStatus(state.streamActive ? 'Listening...' : 'Playing voice...');
      }
    }

    if (event.type === 'assistant.audio.ended') {
      if (state.cancelledAudioTurnIds.has(event.payload.turnId)) {
        return;
      }

      markAssistantAudioActivity(event.payload.turnId);
      scheduleStreamFlush(event.payload.turnId);

      if (state.assistantAudioTurnId === event.payload.turnId) {
        state.assistantAudioActive = false;
        state.assistantAudioTurnId = null;
      }
      setStatus(state.streamActive ? 'Listening...' : 'Voice ready');
    }

    if (event.type === 'session.ended') {
      state.sessionId = null;
      resetAssistantOutputState();
      setStatus('Session ended');
    }

    if (event.type === 'error') {
      state.assistantBusy = false;
      setStatus(`${event.payload.code}: ${event.payload.message}`);
    }

    updateButtons();
  });

  state.socket.addEventListener('close', () => {
    state.sessionId = null;
    resetAssistantOutputState();
    void stopLiveMic().catch(() => undefined);
    setStatus('Disconnected');
    updateButtons();
  });
});

el.startSession.addEventListener('click', () => {
  send({
    type: 'session.start',
    payload: {
      taskKey: el.taskKey.value,
      metadata: {
        client: 'browser-demo',
        mode: 'continuous-vad',
      },
    },
  });
});

el.startLive.addEventListener('click', () => {
  void startLiveMic().catch((error) => {
    setStatus(error instanceof Error ? error.message : 'Could not start mic');
    updateButtons();
  });
});

el.stopLive.addEventListener('click', () => {
  void stopLiveMic().catch((error) => {
    setStatus(error instanceof Error ? error.message : 'Could not stop mic');
    updateButtons();
  });
});

el.startWebrtc.addEventListener('click', () => {
  void startWebRtcVoice().catch((error) => {
    logClientEvent('webrtc.setup.error', {
      name: error instanceof Error ? error.name : 'Error',
      message:
        error instanceof Error ? error.message : 'Could not start WebRTC voice',
    });
    setStatus(
      error instanceof Error ? error.message : 'Could not start WebRTC voice',
    );
    void stopWebRtcVoice({ notifyGateway: false });
  });
});

el.stopWebrtc.addEventListener('click', () => {
  void stopWebRtcVoice().catch((error) => {
    setStatus(
      error instanceof Error ? error.message : 'Could not stop WebRTC voice',
    );
    updateButtons();
  });
});

el.sendText.addEventListener('click', () => {
  interruptAssistantOutput('text_message');
  state.pendingDebugText = el.debugText.value.trim();
  appendChatMessage('user', state.pendingDebugText);
  send({
    type: 'text.message',
    payload: {
      text: el.debugText.value,
    },
  });
});

el.toggleAudio.addEventListener('click', () => {
  state.audioPlaybackEnabled = !state.audioPlaybackEnabled;

  if (!state.audioPlaybackEnabled) {
    stopAssistantAudio({ cancelTurn: true });
  }

  send({
    type: 'session.audio_output',
    payload: {
      enabled: state.audioPlaybackEnabled,
    },
  });

  updateButtons();
});

el.endSession.addEventListener('click', () => {
  if (state.streamActive) {
    void stopLiveMic();
  }
  resetAssistantOutputState();
  send({ type: 'session.end', payload: {} });
});
