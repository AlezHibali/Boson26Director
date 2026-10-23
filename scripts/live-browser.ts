import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const dir = "docs/evidence/private";
await mkdir(dir, { recursive: true });
const live = JSON.parse(await readFile(dir + "/live-report.json", "utf8"));
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  dir + "/fear.mp3",
  "-af",
  "apad=whole_dur=4",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-y",
  dir + "/microphone-input.wav",
]);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-audio-capture=" +
      resolve(dir + "/microphone-input.wav") +
      "%noloop",
  ],
});
const context = await browser.newContext({
  permissions: ["microphone"],
  viewport: { width: 1440, height: 1100 },
});
await context.addInitScript(() => {
  const original = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (
    ...args: Parameters<typeof original>
  ) {
    const view = window as unknown as { probeAudioStarts: number };
    view.probeAudioStarts = (view.probeAudioStarts || 0) + 1;
    return original.apply(this, args);
  };
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.name));
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  mode: "REAL ENDPOINTS / SYNTHETIC MICROPHONE",
  avatarCreates: 0,
  ttsCalls: 1,
  realtimeSessions: 1,
};
try {
  await page.goto("http://127.0.0.1:3000/lab");
  await expect(page.getByTestId("capabilities")).toContainText("bones", {
    timeout: 30000,
  });
  await page.getByLabel("视频任务 ID").fill(live.avatar_actor.id);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByTestId("job-state")).toContainText("completed");
  const video = page.getByLabel("Avatar 生成视频");
  await expect
    .poll(() => video.evaluate((e: HTMLVideoElement) => e.videoWidth), {
      timeout: 15000,
    })
    .toBe(640);
  await video.evaluate((e: HTMLVideoElement) => e.play());
  await expect
    .poll(() => video.evaluate((e: HTMLVideoElement) => e.currentTime))
    .toBeGreaterThan(0.2);
  report.avatar = {
    width: await video.evaluate((e: HTMLVideoElement) => e.videoWidth),
    duration: await video.evaluate((e: HTMLVideoElement) => e.duration),
    played: true,
    source: "Existing completed real job via local API proxy",
  };
  await page.screenshot({
    path: "docs/evidence/stage1-live-video.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "试听 TTS 3" }).click();
  const audio = page.getByLabel("生成的台词音频");
  await expect(audio).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => audio.evaluate((e: HTMLAudioElement) => e.duration))
    .toBeGreaterThan(0);
  await audio.evaluate((e: HTMLAudioElement) => e.play());
  await expect
    .poll(() => audio.evaluate((e: HTMLAudioElement) => e.currentTime))
    .toBeGreaterThan(0.1);
  report.tts = {
    duration: await audio.evaluate((e: HTMLAudioElement) => e.duration),
    played: true,
    source: "Real POST /api/voice-preview",
  };
  await audio.evaluate((e: HTMLAudioElement) => e.pause());
  await video.evaluate((e: HTMLVideoElement) => e.pause());
  const starts = await page.evaluate(
    () =>
      (window as unknown as { probeAudioStarts: number }).probeAudioStarts || 0,
  );
  await page.getByRole("button", { name: "连接麦克风" }).click();
  await expect
    .poll(() => page.getByTestId("realtime-status").innerText(), {
      timeout: 45000,
    })
    .toMatch(/正在播放回复|等待下一句话/);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { probeAudioStarts: number })
              .probeAudioStarts || 0,
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThan(starts);
  report.realtime = {
    status: await page.getByTestId("realtime-status").innerText(),
    playbackBufferStarts: await page.evaluate(
      () =>
        (window as unknown as { probeAudioStarts: number }).probeAudioStarts,
    ),
    input:
      "Previously generated speech fed through Chromium fake microphone, AudioWorklet and real WebSocket",
  };
  await page.getByRole("button", { name: "停止连接" }).click();
  await expect(page.getByTestId("realtime-status")).toContainText(
    "麦克风已释放",
  );
  report.pageErrors = errors;
  report.result = "PASS";
  console.log(
    "PASS real browser: existing Avatar MP4, live TTS, synthetic microphone -> real Realtime -> scheduled audio playback.",
  );
} catch (error) {
  report.result = "FAILED";
  report.error = error instanceof Error ? error.message : "unknown";
  process.exitCode = 1;
  console.error("Live browser failed; see private report.");
} finally {
  await writeFile(
    dir + "/live-browser-report.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
