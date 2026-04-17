const vadConfig = {
  minSpeechThreshold: 0.025,
  noiseMultiplier: 3,
  silenceMs: 700,
  minUtteranceMs: 450,
  minSpeechMs: 300,
  minAudioBytes: 2500,
  minPeakLevel: 0.035,
  minBargeInLevel: 0.025,
  bargeInThresholdMultiplier: 2.2,
  bargeInHoldMs: 280,
  bargeInMinPeakLevel: 0.06,
  bargeInMinSpeechMs: 500,
  chunkMs: 100,
  prerollMs: 500,
  partialTranscriptMs: 1200,
  partialTranscriptMinMs: 900,
  partialTranscriptMaxMs: 6000,
  partialTranscriptMinNewMs: 600,
};

const state = {
  socket: null,
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
  cancelledAudioTurnIds: new Set(),
  interruptSentForTurnIds: new Set(),
  streamActive: false,
  audioPlaybackEnabled: true,
  playbackContext: null,
  streamPlaybackNode: null,
  streamPlaybackReady: null,
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
};

const el = {
  wsUrl: document.querySelector('#wsUrl'),
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
  sendText: document.querySelector('#sendText'),
  toggleAudio: document.querySelector('#toggleAudio'),
  endSession: document.querySelector('#endSession'),
  debugText: document.querySelector('#debugText'),
  status: document.querySelector('#status'),
  micLevel: document.querySelector('#micLevel'),
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

function initializeWebSocketUrl() {
  if (el.wsUrl.value === 'ws://localhost:3000/realtime') {
    el.wsUrl.value = defaultWebSocketUrl();
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
  el.startSession.disabled = !connected || hasSession;
  el.startLive.disabled = !hasSession || state.streamActive;
  el.stopLive.disabled = !state.streamActive;
  el.sendText.disabled = !hasSession;
  el.toggleAudio.disabled = !hasSession;
  el.toggleAudio.textContent = state.audioPlaybackEnabled
    ? 'Audio on'
    : 'Audio off';
  el.endSession.disabled = !hasSession;
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

function getMicLevel() {
  if (!state.analyser) {
    return 0;
  }

  const samples = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(samples);

  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / samples.length);
}

function updateMicMeter(level) {
  el.micLevel.style.width = `${Math.min(100, Math.round(level * 500))}%`;
}

function getCurrentAssistantTurnId() {
  return state.assistantAudioTurnId ?? state.lastAssistantTurnId;
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
  return state.assistantBusy || hasAssistantVoiceOutput();
}

function isLikelyBargeIn(level, threshold) {
  return (
    level >= vadConfig.bargeInMinPeakLevel &&
    level >= vadConfig.minBargeInLevel &&
    level >= threshold * vadConfig.bargeInThresholdMultiplier
  );
}

function shouldStartUtterance(level, threshold, deltaMs) {
  if (!hasAssistantVoiceOutput()) {
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

  if (state.assistantAudioTurnId === turnId) {
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

  if (payload.streaming && payload.encoding === 'pcm_s16le') {
    return enqueueAssistantPcmAudio(payload);
  }

  const token = state.audioPlaybackToken;
  const audioBuffer = audioBase64ToArrayBuffer(payload.audioBase64);
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
  const startedDuringAssistantOutput = hasAssistantVoiceOutput();
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
    window.setTimeout(resolve, 120);
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
    state.lastVoiceAt = now;
    if (startingNewUtterance) {
      startUtteranceRecorder(speechThreshold);
    }
  }

  if (state.currentTurn) {
    state.currentTurn.levelFrames += 1;
    state.currentTurn.levelSum += level;
    state.currentTurn.maxLevel = Math.max(state.currentTurn.maxLevel, level);

    if (speechDetected) {
      state.currentTurn.speechMs += deltaMs;
    }
  }

  if (state.currentTurn) {
    const silenceForMs = now - state.lastVoiceAt;
    const utteranceMs = now - state.recordingStartedAt;

    maybeSendPartialTranscript(state.currentTurn, now);

    if (
      silenceForMs >= vadConfig.silenceMs &&
      utteranceMs >= vadConfig.minUtteranceMs
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

  const processor = state.audioContext.createScriptProcessor(4096, 1, 1);
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
    },
  });

  state.audioContext = new AudioContext();
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

    if (event.type === 'session.audio_output.updated') {
      state.audioPlaybackEnabled = event.payload.enabled;
      if (!state.audioPlaybackEnabled) {
        stopAssistantAudio({ cancelTurn: true });
      }
    }

    if (event.type === 'transcript.final') {
      const transcript = event.payload.text || '';
      if (transcript !== state.pendingDebugText) {
        appendChatMessage('user', transcript);
      }
      state.pendingDebugText = '';
      state.latestPartialTranscript = '';
      setStatus(`Heard: ${event.payload.text || '(empty)'}`);
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
      state.lastAssistantTurnId = event.payload.turnId;
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
