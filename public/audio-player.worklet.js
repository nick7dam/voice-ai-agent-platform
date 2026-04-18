class PcmStreamPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readIndex = 0;
    this.bufferedFrames = 0;
    this.inputSampleRate = 24000;
    this.wasPlaying = false;
    this.started = false;
    this.prebufferFrames = Math.round(sampleRate * 0.08);
    this.leftoverByte = null;

    this.port.onmessage = (message) => {
      const data = message.data || {};

      if (data.type === 'configure') {
        this.inputSampleRate = this.validSampleRate(
          data.inputSampleRate,
          this.inputSampleRate,
        );
        return;
      }

      if (data.type === 'clear') {
        this.queue = [];
        this.readIndex = 0;
        this.bufferedFrames = 0;
        this.wasPlaying = false;
        this.started = false;
        this.leftoverByte = null;
        return;
      }

      if (data.type === 'flush') {
        if (this.queue.length > 0 || this.bufferedFrames > 0) {
          this.started = true;
        }
        return;
      }

      if (data.type === 'chunk') {
        const inputRate = this.validSampleRate(
          data.inputSampleRate,
          this.inputSampleRate,
        );
        this.inputSampleRate = inputRate;
        const frames = this.decodePcm16(data.audio, inputRate);

        if (frames.length === 0) {
          return;
        }

        this.queue.push(frames);
        this.bufferedFrames += frames.length;
        this.wasPlaying = true;
      }
    };
  }

  validSampleRate(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  decodePcm16(buffer, inputRate) {
    if (!buffer || buffer.byteLength === 0) {
      return new Float32Array(0);
    }

    let bytes = new Uint8Array(buffer);

    if (this.leftoverByte !== null) {
      const combined = new Uint8Array(bytes.length + 1);
      combined[0] = this.leftoverByte;
      combined.set(bytes, 1);
      bytes = combined;
      this.leftoverByte = null;
    }

    const usableBytes = bytes.byteLength - (bytes.byteLength % 2);
    if (usableBytes !== bytes.byteLength) {
      this.leftoverByte = bytes[bytes.byteLength - 1];
    }

    if (usableBytes < 2) {
      return new Float32Array(0);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
    const inputFrames = new Float32Array(usableBytes / 2);
    for (let index = 0; index < inputFrames.length; index += 1) {
      inputFrames[index] = Math.max(
        -1,
        Math.min(1, view.getInt16(index * 2, true) / 32768),
      );
    }

    const outputRate = sampleRate;

    if (inputRate === outputRate) {
      return inputFrames;
    }

    const outputLength = Math.max(
      1,
      Math.round((inputFrames.length * outputRate) / inputRate),
    );
    const frames = new Float32Array(outputLength);

    for (let index = 0; index < outputLength; index += 1) {
      const sourceIndex = (index * inputRate) / outputRate;
      const left = Math.floor(sourceIndex);
      const right = Math.min(left + 1, inputFrames.length - 1);
      const fraction = sourceIndex - left;
      const sample =
        inputFrames[left] * (1 - fraction) + inputFrames[right] * fraction;
      frames[index] = Math.max(-1, Math.min(1, sample));
    }

    return frames;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];

    if (!output) {
      return true;
    }

    if (!this.started) {
      if (this.bufferedFrames < this.prebufferFrames) {
        output.fill(0);
        return true;
      }

      this.started = true;
    }

    let outputIndex = 0;

    while (outputIndex < output.length) {
      const current = this.queue[0];

      if (!current) {
        output.fill(0, outputIndex);

        if (this.wasPlaying) {
          this.wasPlaying = false;
          this.started = false;
          this.port.postMessage({ type: 'drain' });
        }

        return true;
      }

      const available = current.length - this.readIndex;
      const requested = output.length - outputIndex;
      const framesToCopy = Math.min(available, requested);

      output.set(
        current.subarray(this.readIndex, this.readIndex + framesToCopy),
        outputIndex,
      );

      this.readIndex += framesToCopy;
      outputIndex += framesToCopy;
      this.bufferedFrames -= framesToCopy;

      if (this.readIndex >= current.length) {
        this.queue.shift();
        this.readIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-stream-player', PcmStreamPlayer);
