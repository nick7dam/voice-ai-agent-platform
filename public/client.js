const vadConfig = {
  minSpeechThreshold: 0.025,
  noiseMultiplier: 3,
  bargeInThresholdMultiplier: 2.4,
  bargeInMinPeakLevel: 0.055,
  bargeInHoldMs: 120,
  assistantAudioGraceMs: 1500,
};

const state = {
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
  noiseFloor: 0.006,
  assistantBusy: false,
  assistantAudioActive: false,
  assistantAudioTurnId: null,
  lastAssistantTurnId: null,
  lastAssistantAudioAt: 0,
  cancelledAudioTurnIds: new Set(),
  interruptSentForTurnIds: new Set(),
  latency: {
    sttMs: null,
    firstTokenMs: null,
    firstTextMs: null,
    firstAudioMs: null,
  },
};

const el = {
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
  startWebrtc: document.querySelector('#startWebrtc'),
  stopWebrtc: document.querySelector('#stopWebrtc'),
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

function defaultWebRtcUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (window.location.protocol === 'https:') {
    return `${protocol}//${window.location.host}/voice`;
  }

  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:8004`;
}

function initializeWebRtcUrl() {
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
  const trimmed = String(text || '').trim();
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

function updateButtons() {
  el.startWebrtc.disabled = state.webrtcActive;
  el.stopWebrtc.disabled = !state.webrtcActive;
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

function updateMicMeter(level) {
  el.micLevel.style.width = `${Math.min(100, Math.round(level * 500))}%`;
}

function getSpeechThreshold() {
  return Math.max(
    vadConfig.minSpeechThreshold,
    state.noiseFloor * vadConfig.noiseMultiplier,
  );
}

function updateNoiseFloor(level) {
  const threshold = getSpeechThreshold();
  if (level >= threshold || hasInterruptibleAssistantOutput()) {
    return;
  }

  state.noiseFloor = state.noiseFloor * 0.94 + level * 0.06;
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

function hasInterruptibleAssistantOutput() {
  return (
    state.assistantBusy ||
    state.assistantAudioActive ||
    hasRecentAssistantAudioActivity()
  );
}

function isLikelyBargeIn(level, threshold) {
  return (
    level >= vadConfig.bargeInMinPeakLevel &&
    level >= threshold * vadConfig.bargeInThresholdMultiplier
  );
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

function clearWebRtcDisconnectTimer() {
  if (!state.webrtcDisconnectTimer) {
    return;
  }

  window.clearTimeout(state.webrtcDisconnectTimer);
  state.webrtcDisconnectTimer = null;
}

function setWebRtcRemoteAudioEnabled(enabled) {
  state.webrtcRemoteStream?.getAudioTracks().forEach((track) => {
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

    if (state.webrtcBargeInCandidateMs >= vadConfig.bargeInHoldMs) {
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
    state.assistantBusy = false;
    state.assistantAudioActive = false;
    state.assistantAudioTurnId = null;
    state.lastAssistantTurnId = null;
    state.cancelledAudioTurnIds.clear();
    state.interruptSentForTurnIds.clear();
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

  if (event.type === 'gateway.transcription.empty') {
    setStatus('WebRTC did not catch that');
  }

  if (event.type === 'gateway.latency.updated') {
    updateLatencyMetrics(event.payload);
  }

  if (event.type === 'reasoning.started') {
    state.assistantBusy = true;
    state.lastAssistantTurnId = event.payload.turnId;
    setStatus('WebRTC thinking...');
  }

  if (event.type === 'reasoning.first_token') {
    updateLatencyMetrics({ firstTokenMs: event.payload.latencyMs });
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
    updateLatencyMetrics({ sttMs: event.payload.latencyMs });
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
    state.assistantBusy = false;
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

  if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
    return 'No microphone was found by the browser.';
  }

  if (error.name === 'NotReadableError') {
    return 'The browser could not read the microphone. Another app may be using it.';
  }

  return error.message || fallback;
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
    logClientEvent('webrtc.signaling.closed', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });

    if (state.webrtcActive) {
      const reason = event.reason
        ? ` ${event.reason}`
        : event.wasClean
          ? ''
          : ' unexpectedly';
      setStatus(`WebRTC signaling closed${reason} code=${event.code}`);
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
  state.assistantBusy = false;
  state.assistantAudioActive = false;
  state.assistantAudioTurnId = null;
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

initializeWebRtcUrl();
updateButtons();
void loadTaskConfig().catch((error) => {
  setTaskStatus(error instanceof Error ? error.message : 'Could not load task');
});
