import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const dir = "docs/evidence/private/stage3";
await mkdir(dir, { recursive: true });
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  dir + "/03-turn-wave-en.mp3",
  "-af",
  "adelay=1500,apad=whole_dur=10",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-y",
  dir + "/browser-mic.wav",
]);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-audio-capture=" +
      resolve(dir + "/browser-mic.wav") +
      "%noloop",
  ],
});
const context = await browser.newContext({
  permissions: ["microphone"],
  viewport: { width: 1920, height: 1080 },
});
await context.addInitScript(() => {
  const original = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );
  navigator.mediaDevices.getUserMedia = async (input) => {
    const stream = await original(input);
    (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks =
      stream.getTracks();
    return stream;
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (
    ...args: Parameters<typeof start>
  ) {
    const w = window as unknown as { replyStarts: number };
    w.replyStarts = (w.replyStarts || 0) + 1;
    return start.apply(this, args);
  };
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const outputs: unknown[] = [];
page.on("websocket", (socket) =>
  socket.on("framesent", (frame) => {
    try {
      const event = JSON.parse(frame.payload.toString());
      if (event.item?.type === "function_call_output")
        outputs.push({
          callId: event.item.call_id,
          result: JSON.parse(event.item.output),
        });
    } catch {}
  }),
);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  mode: "REAL BOSON / BROWSER / SYNTHETIC MICROPHONE",
  utterance: "Turn the actor right forty-five degrees and wave.",
  limitations: [
    "Synthetic microphone; physical microphone and human listening acceptance remain separate.",
  ],
};
try {
  await page.goto("http://127.0.0.1:3000");
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  const scene = async () =>
    JSON.parse((await page.getByTestId("scene-state").textContent())!);
  await expect
    .poll(async () => (await scene()).actor.rotationY, { timeout: 45000 })
    .toBe(45);
  await expect(page.getByTestId("animation-status")).toHaveText("Idle", {
    timeout: 12000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { replyStarts: number }).replyStarts || 0,
        ),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
  const render = JSON.parse(
    (await page.getByTestId("render-state").textContent())!,
  );
  expect(render.actors).toBe(1);
  expect(render.rotationY).toBeCloseTo(45);
  report.scene = await scene();
  report.render = render;
  report.heard = await page.getByTestId("voice-heard").innerText();
  report.toolOutputs = outputs;
  report.replyBufferStarts = await page.evaluate(
    () => (window as unknown as { replyStarts: number }).replyStarts,
  );
  report.pageErrors = errors;
  await page.screenshot({
    path: "docs/evidence/stage3-live-browser.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
  report.tracksReleased = await page.evaluate(() =>
    (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks.every(
      (track) => track.readyState === "ended",
    ),
  );
  expect(report.tracksReleased).toBe(true);
  expect(errors).toEqual([]);
  report.result = "PASS";
  console.log(
    "PASS real browser: spoken command -> actual Higgs tool -> 45 degree actor rotation, one Wave/Idle, audible reply graph and released microphone.",
  );
} catch (error) {
  report.result = "FAILED";
  report.error = error instanceof Error ? error.message : "Unknown";
  process.exitCode = 1;
  console.error("Live director browser failed; see private report.");
} finally {
  await writeFile(
    dir + "/browser-report.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
