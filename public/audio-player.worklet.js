class PcmStreamPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readIndex = 0;
    this.bufferedFrames = 0;
    this.inputSampleRate = 24000;
    this.wasPlaying = false;

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
    if (!buffer || buffer.byteLength < 2) {
      return new Float32Array(0);
    }

    const usableBytes = buffer.byteLength - (buffer.byteLength % 2);
    const pcm = new Int16Array(buffer.slice(0, usableBytes));
    const outputRate = sampleRate;

    if (inputRate === outputRate) {
      const frames = new Float32Array(pcm.length);
      for (let index = 0; index < pcm.length; index += 1) {
        frames[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
      }
      return frames;
    }

    const outputLength = Math.max(
      1,
      Math.round((pcm.length * outputRate) / inputRate),
    );
    const frames = new Float32Array(outputLength);

    for (let index = 0; index < outputLength; index += 1) {
      const sourceIndex = (index * inputRate) / outputRate;
      const left = Math.floor(sourceIndex);
      const right = Math.min(left + 1, pcm.length - 1);
      const fraction = sourceIndex - left;
      const sample =
        (pcm[left] * (1 - fraction) + pcm[right] * fraction) / 32768;
      frames[index] = Math.max(-1, Math.min(1, sample));
    }

    return frames;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];

    if (!output) {
      return true;
    }

    let outputIndex = 0;

    while (outputIndex < output.length) {
      const current = this.queue[0];

      if (!current) {
        output.fill(0, outputIndex);

        if (this.wasPlaying) {
          this.wasPlaying = false;
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
