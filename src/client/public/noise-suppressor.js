/**
 * Wyre noise suppressor: STFT spectral gating with an adaptive noise floor.
 *
 * This is a real DSP filter running in an AudioWorklet, not a machine-learning
 * model. It removes steady background noise (fans, traffic, hum) on top of the
 * browser's own `noiseSuppression` constraint; it does not claim RNNoise/Krisp
 * quality on non-stationary noise such as speech in the background.
 *
 * Standard overlap-add: frames of FFT_SIZE are analysed every HOP_SIZE samples,
 * and the reconstructed output is delayed by exactly one frame.
 */
const FFT_SIZE = 512;
const HOP_SIZE = 128;

function hann(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

/** Iterative radix-2 FFT over separate real/imaginary buffers. */
function fft(real, imag) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;
      const tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let curReal = 1;
      let curImag = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const a = start + offset;
        const b = a + length / 2;
        const tReal = real[b] * curReal - imag[b] * curImag;
        const tImag = real[b] * curImag + imag[b] * curReal;
        real[b] = real[a] - tReal;
        imag[b] = imag[a] - tImag;
        real[a] += tReal;
        imag[a] += tImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

function ifft(real, imag) {
  fft(imag, real);
  const size = real.length;
  for (let i = 0; i < size; i += 1) {
    real[i] /= size;
    imag[i] /= size;
  }
}

class NoiseSuppressor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.window = hann(FFT_SIZE);
    // Hann with 75% overlap sums to a constant, which this factor normalises.
    this.normalisation = 1 / 1.5;
    this.analysis = new Float32Array(FFT_SIZE);
    this.synthesis = new Float32Array(FFT_SIZE);
    this.filled = 0;
    this.real = new Float32Array(FFT_SIZE);
    this.imag = new Float32Array(FFT_SIZE);
    this.noise = new Float32Array(FFT_SIZE / 2 + 1).fill(1e-5);
    this.frames = 0;
    this.port.onmessage = (event) => {
      if (typeof event.data?.enabled === 'boolean') this.enabled = event.data.enabled;
    };
  }

  processFrame() {
    const { real, imag, analysis, window, noise } = this;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      real[i] = analysis[i] * window[i];
      imag[i] = 0;
    }
    fft(real, imag);

    const bins = FFT_SIZE / 2 + 1;
    let loud = 0;
    for (let bin = 0; bin < bins; bin += 1) {
      const power = real[bin] * real[bin] + imag[bin] * imag[bin];
      // Early frames and quiet frames update the noise estimate faster.
      const adapt = this.frames < 16 ? 0.4 : power < noise[bin] * 2 ? 0.05 : 0.002;
      noise[bin] += adapt * (power - noise[bin]);
      if (power > noise[bin] * 4) loud += 1;
    }
    const aggressive = loud < bins * 0.05;

    for (let bin = 0; bin < bins; bin += 1) {
      const power = real[bin] * real[bin] + imag[bin] * imag[bin];
      const ratio = power / (noise[bin] * (aggressive ? 3 : 2) + 1e-12);
      // Wiener-style gain with a floor, so speech keeps its natural timbre.
      const gain = ratio <= 1 ? 0.12 : Math.max(0.12, Math.min(1, (ratio - 1) / ratio));
      real[bin] *= gain;
      imag[bin] *= gain;
      if (bin > 0 && bin < FFT_SIZE / 2) {
        real[FFT_SIZE - bin] = real[bin];
        imag[FFT_SIZE - bin] = -imag[bin];
      }
    }

    ifft(real, imag);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      this.synthesis[i] += real[i] * window[i] * this.normalisation;
    }
    this.frames += 1;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    if (!this.enabled) {
      output.set(input);
      return true;
    }

    const size = Math.min(input.length, HOP_SIZE);
    // Shift in the new hop.
    this.analysis.copyWithin(0, size);
    this.analysis.set(input.subarray(0, size), FFT_SIZE - size);
    this.filled = Math.min(FFT_SIZE, this.filled + size);

    if (this.filled < FFT_SIZE) {
      output.fill(0);
      return true;
    }

    this.processFrame();
    output.set(this.synthesis.subarray(0, size));
    this.synthesis.copyWithin(0, size);
    this.synthesis.fill(0, FFT_SIZE - size);
    return true;
  }
}

registerProcessor('wyre-noise-suppressor', NoiseSuppressor);
