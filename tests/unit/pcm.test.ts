import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
it.each([24000, 44100, 48000])(
  "worklet produces exact PCM16 LE mono duration at source rate %i",
  (sampleRate) => {
    let Processor: new () => { process: (input: Float32Array[][]) => void };
    const chunks: ArrayBuffer[] = [];
    class Stub {
      port = { postMessage: (data: ArrayBuffer) => chunks.push(data) };
    }
    runInNewContext(readFileSync("public/audio/pcm-capture.js", "utf8"), {
      AudioWorkletProcessor: Stub,
      sampleRate,
      registerProcessor: (_name: string, p: typeof Processor) => {
        Processor = p;
      },
    });
    const processor = new Processor!();
    const input = new Float32Array(sampleRate).fill(0.5);
    for (let i = 0; i < input.length; i += 128)
      processor.process([[input.subarray(i, i + 128)]]);
    const samples = chunks.reduce((n, chunk) => n + chunk.byteLength / 2, 0);
    expect(samples).toBe(24000);
    expect(new DataView(chunks[0]).getInt16(0, true)).toBe(16384);
  },
);
