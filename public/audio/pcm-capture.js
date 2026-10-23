class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.total = 0; this.weight = 0; this.ratio = sampleRate / 24000; this.samples = []; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const used = Math.min(remaining, this.ratio - this.weight);
        this.total += sample * used; this.weight += used; remaining -= used;
        if (this.weight >= this.ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, this.total / this.ratio));
          this.samples.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          this.total = 0; this.weight = 0;
          if (this.samples.length === 2400) {
            const buffer = new ArrayBuffer(4800); const view = new DataView(buffer);
            this.samples.forEach((v,i) => view.setInt16(i*2,v,true));
            this.port.postMessage(buffer,[buffer]); this.samples = [];
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
