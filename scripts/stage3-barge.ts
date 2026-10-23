import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const dir = "docs/evidence/private/stage3";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  const micSources = new WeakSet<AudioBufferSourceNode>();
  const replySources = new Set<AudioBufferSourceNode>();
  const view = window as unknown as {
    feedSpeech: (base64: string) => Promise<void>;
    replyActive: () => number;
    replyStops: number;
    micContext?: AudioContext;
  };
  view.replyStops = 0;
  view.replyActive = () => replySources.size;
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (
    ...args: Parameters<typeof start>
  ) {
    if (!micSources.has(this)) {
      replySources.add(this);
      this.addEventListener("ended", () => replySources.delete(this));
    }
    return start.apply(this, args);
  };
  AudioBufferSourceNode.prototype.stop = function (
    ...args: Parameters<typeof stop>
  ) {
    if (replySources.has(this)) view.replyStops++;
    return stop.apply(this, args);
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext({ sampleRate: 24000 });
    view.micContext = context;
    await context.resume();
    const output = context.createMediaStreamDestination();
    view.feedSpeech = async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const buffer = await context.decodeAudioData(bytes.buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      micSources.add(source);
      source.connect(output);
      await new Promise<void>((yes) => {
        source.onended = () => yes();
        source.start();
      });
    };
    return output.stream;
  };
});
const sent: string[] = [];
const errors: unknown[] = [];
page.on("websocket", (ws) => {
  ws.on("framesent", (frame) => {
    try {
      const event = JSON.parse(frame.payload.toString());
      if (event.type === "conversation.item.truncate") sent.push(event.item_id);
    } catch {}
  });
  ws.on("framereceived", (frame) => {
    try {
      const event = JSON.parse(frame.payload.toString());
      if (event.type === "error")
        errors.push({ type: event.error?.type, code: event.error?.code });
    } catch {}
  });
});
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  mode: "REAL PROVIDER BARGE-IN / CONTROLLED WEB AUDIO MICROPHONE",
};
try {
  await page.goto("http://127.0.0.1:3000");
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("已连接", {
    timeout: 20000,
  });
  await page.evaluate(
    async (bytes) =>
      (
        window as unknown as { feedSpeech: (s: string) => Promise<void> }
      ).feedSpeech(bytes),
    (await readFile(dir + "/03-turn-wave-en.mp3")).toString("base64"),
  );
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { replyActive: () => number }).replyActive(),
        ),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
  await page.evaluate(
    async (bytes) =>
      (
        window as unknown as { feedSpeech: (s: string) => Promise<void> }
      ).feedSpeech(bytes),
    (await readFile(dir + "/04-dolly-zh.mp3")).toString("base64"),
  );
  const scene = async () =>
    JSON.parse((await page.getByTestId("scene-state").textContent())!);
  await expect
    .poll(async () => (await scene()).camera.distance, { timeout: 30000 })
    .toBe(4.8);
  report.replyStops = await page.evaluate(
    () => (window as unknown as { replyStops: number }).replyStops,
  );
  report.truncationRequests = sent.length;
  report.runtime = JSON.parse(
    (await page.getByTestId("voice-runtime").textContent())!,
  );
  report.scene = await scene();
  report.providerErrors = errors;
  report.status = await page.getByTestId("voice-status").innerText();
  expect(report.replyStops).toBeGreaterThan(0);
  expect(sent.length).toBeGreaterThan(0);
  expect(
    (report.runtime as { interruptionMs: number }).interruptionMs,
  ).toBeLessThanOrEqual(300);
  expect(errors).toEqual([]);
  report.result = "PASS";
  console.log(
    "PASS real provider: second spoken command interrupted scheduled reply audio and moved camera without losing actor staging.",
  );
} catch (error) {
  report.result = "FAILED";
  report.error = error instanceof Error ? error.message : "Unknown";
  report.providerErrors = errors;
  console.error("Real barge-in failed; see private report.");
  process.exitCode = 1;
} finally {
  await writeFile(dir + "/barge-report.json", JSON.stringify(report, null, 2));
  await browser.close();
}
