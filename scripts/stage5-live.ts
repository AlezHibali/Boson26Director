import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
const base = "http://127.0.0.1:3000",
  dir = "docs/evidence/private/stage5";
try {
  process.loadEnvFile(".env.local");
} catch {}
const key = process.env.BOSON_API_KEY;
if (!key)
  throw Error(
    "A local server credential is required for this explicit live probe.",
  );
await mkdir(dir, { recursive: true });
const diagnostic = await (await fetch(base + "/api/diagnostics")).json();
if (!diagnostic.configured)
  throw Error("Start the real local server before live verification.");
const report: any = {
  date: new Date().toISOString(),
  mode: "REAL BOSON / installed Chrome and Edge / cached synthetic microphone",
  avatarSubmissions: 0,
  physicalMicrophone: "pending human acceptance",
  subjectiveEmotion: "pending human listening",
  browsers: [],
};
try {
  report.tts = JSON.parse(await readFile(dir + "/tts.json", "utf8"));
  report.tts.reused = true;
} catch {
  const start = performance.now();
  const r = await fetch(base + "/api/voice-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Ready for the next take.",
      emotion: "neutral",
    }),
  });
  if (!r.ok) throw Error("Controlled TTS probe failed; no automatic retry.");
  const headersMs = Math.round(performance.now() - start),
    bytes = new Uint8Array(await r.arrayBuffer());
  await writeFile(dir + "/ready.mp3", bytes);
  report.tts = {
    date: new Date().toISOString(),
    headersMs,
    bodyCompletedMs: Math.round(performance.now() - start),
    bytes: bytes.length,
    reused: false,
  };
  await writeFile(dir + "/tts.json", JSON.stringify(report.tts, null, 2));
}
const wav = resolve("docs/evidence/private/stage3/browser-mic.wav");
await access(wav);
const history = await (await fetch(base + "/api/takes")).json();
const clips = history.takes
  .filter((t: any) => t.status === "completed" && !t.input.diagnostic)
  .slice(0, 2);
if (clips.length < 2)
  throw Error(
    "Two saved clips are required. This script never creates Avatar tasks.",
  );
for (const channel of ["chrome", "msedge"] as const) {
  const browser = await chromium.launch({
    channel,
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--use-file-for-fake-audio-capture=" + wav + "%noloop",
    ],
  });
  try {
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1920, height: 1080 },
    });
    await context.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (c) => {
        const stream = await original(c);
        (window as any).liveDemoTracks = stream.getTracks();
        return stream;
      };
    });
    const page = await context.newPage();
    let consoleErrors = 0,
      pageErrors = 0,
      secretLeak = false,
      paidCreates = 0;
    const outputs: any[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors++;
      if (m.text().includes(key!)) secretLeak = true;
    });
    page.on("pageerror", () => pageErrors++);
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        ["/api/takes", "/api/takes/retake", "/api/avatar"].includes(
          new URL(r.url()).pathname,
        )
      )
        paidCreates++;
    });
    page.on("websocket", (s) =>
      s.on("framesent", (f) => {
        try {
          const e = JSON.parse(f.payload.toString());
          if (e.item?.type === "function_call_output") {
            const o = JSON.parse(e.item.output);
            outputs.push({ ok: o.ok, revision: o.revision });
          }
        } catch {}
      }),
    );
    await page.goto(base);
    await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
      timeout: 30000,
    });
    await page.getByTestId("prepare-demo").click();
    await expect(page.getByTestId("demo-status")).toContainText("预设就绪");
    const start = performance.now();
    await page
      .getByRole("button", { name: "连接语音导演", exact: true })
      .click();
    await expect
      .poll(() => outputs.some((o) => o.ok), { timeout: 45000 })
      .toBe(true);
    const roundTripFromConnectMs = Math.round(performance.now() - start);
    const scene = async () =>
      JSON.parse((await page.getByTestId("scene-state").textContent())!);
    await expect
      .poll(async () => (await scene()).actor.rotationY, { timeout: 10000 })
      .toBe(90);
    await expect
      .poll(async () => (await scene()).actor.animation.name, {
        timeout: 10000,
      })
      .toBe("Idle");
    await page.getByRole("button", { name: "停止语音", exact: true }).click();
    expect(
      await page.evaluate(() =>
        (window as any).liveDemoTracks.every(
          (t: MediaStreamTrack) => t.readyState === "ended",
        ),
      ),
    ).toBe(true);
    const before = await scene(),
      widths: number[] = [];
    for (const clip of clips) {
      await page.getByTestId("take-" + clip.id).click();
      const video = page.getByTestId("take-video");
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), {
          timeout: 20000,
        })
        .toBe(640);
      await video.evaluate((v: HTMLVideoElement) => v.play());
      await page.getByRole("button", { name: "Cut · 停止播放" }).click();
      expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(
        true,
      );
      widths.push(await video.evaluate((v: HTMLVideoElement) => v.videoWidth));
    }
    expect(await scene()).toEqual(before);
    await expect(page.getByTestId("selected-take")).toContainText("预生成");
    await page
      .locator(".take-panel")
      .screenshot({ path: "docs/evidence/stage5-live-" + channel + ".png" });
    expect(paidCreates).toBe(0);
    expect(secretLeak).toBe(false);
    expect(pageErrors).toBe(0);
    expect(consoleErrors).toBe(0);
    report.browsers.push({
      channel,
      version: browser.version(),
      roundTripFromConnectMs,
      successfulToolOutputs: outputs.length,
      rotationY: before.actor.rotationY,
      animation: before.actor.animation.name,
      videoWidths: widths,
      microphoneTracksEnded: true,
      preGeneratedLabel: true,
      stageUnchangedDuringPlayback: true,
      consoleErrors,
      pageErrors,
      masterKeySeen: secretLeak,
      avatarSubmissions: paidCreates,
    });
  } finally {
    await browser.close();
  }
}
const metricsResponse = await fetch(base + "/api/metrics");
const metrics = await metricsResponse.json();
if (JSON.stringify(metrics).includes(key))
  throw Error("Credential appeared in metrics.");
report.metrics = metrics;
report.avatarTotalSampleNote =
  "No new Avatar was submitted. Historic Stage 4 jobs predate completedAt instrumentation; no total duration is inferred.";
await writeFile(
  "docs/evidence/stage5-live-summary.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      browsers: report.browsers.map((b: any) => ({
        channel: b.channel,
        ok: true,
        roundTripFromConnectMs: b.roundTripFromConnectMs,
      })),
      avatarSubmissions: 0,
      ttsReused: report.tts.reused,
    },
    null,
    2,
  ),
);
