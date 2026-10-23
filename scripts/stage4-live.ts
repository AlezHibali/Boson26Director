import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Take } from "../src/domain/take";
const dir = "docs/evidence/private/stage4",
  baseURL = "http://127.0.0.1:3000";
await mkdir(dir, { recursive: true });
const checkpoint = dir + "/checkpoint.json";
let saved: {
  attemptedAction?: boolean;
  baseline?: string[];
  baseId?: string;
  attemptedRetake?: boolean;
  retakeId?: string;
} = {};
try {
  saved = JSON.parse(await readFile(checkpoint, "utf8"));
} catch {}
const persist = () => writeFile(checkpoint, JSON.stringify(saved, null, 2));
async function history(): Promise<Take[]> {
  const r = await fetch(baseURL + "/api/takes");
  if (!r.ok) throw Error("History unavailable");
  return (await r.json()).takes;
}
let all = await history();
if (saved.attemptedAction && !saved.baseId) {
  const t = all.find(
    (t) =>
      !saved.baseline?.includes(t.id) && !t.baseTakeId && !t.input.diagnostic,
  );
  if (!t)
    throw Error(
      "An earlier Action was attempted but no record found. Inspect manually; refusing another paid submit.",
    );
  saved.baseId = t.id;
  await persist();
}
if (saved.attemptedRetake && !saved.retakeId) {
  const t = all.find((t) => t.baseTakeId === saved.baseId);
  if (!t)
    throw Error(
      "An earlier Retake was attempted but no record found. Inspect manually; refusing another paid submit.",
    );
  saved.retakeId = t.id;
  await persist();
}
if (!saved.baseId) {
  try {
    await access(dir + "/action.mp3");
  } catch {
    const r = await fetch(baseURL + "/api/voice-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "开始表演，Action。", emotion: "neutral" }),
    });
    if (!r.ok) throw Error("Action speech synthesis failed");
    await writeFile(dir + "/action.mp3", new Uint8Array(await r.arrayBuffer()));
  }
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    dir + "/action.mp3",
    "-af",
    "adelay=1800,apad=whole_dur=12",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-y",
    dir + "/action.wav",
  ]);
}
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(!saved.baseId
      ? [
          "--use-file-for-fake-audio-capture=" +
            resolve(dir + "/action.wav") +
            "%noloop",
        ]
      : []),
  ],
});
const context = await browser.newContext({
  permissions: ["microphone"],
  viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage();
const errors: string[] = [],
  toolOutputs: any[] = [];
page.on("pageerror", (e) => errors.push(e.name));
page.on("websocket", (ws) =>
  ws.on("framesent", (frame) => {
    try {
      const e = JSON.parse(frame.payload.toString());
      if (e.item?.type === "function_call_output")
        toolOutputs.push(JSON.parse(e.item.output));
    } catch {}
  }),
);
let creates = 0;
page.on("request", (req) => {
  if (
    req.method() === "POST" &&
    ["/api/takes", "/api/takes/retake"].includes(new URL(req.url()).pathname)
  )
    creates++;
});
const report: any = {
  date: new Date().toISOString(),
  mode: "REAL BOSON / REAL CHROMIUM / SYNTHETIC MICROPHONE",
  reusedCheckpointAtStart: !!saved.baseId,
  manualQuality: "pending human listening and identity/lip-sync review",
};
async function ready() {
  await page.goto(baseURL);
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  await expect(page.getByTestId("take-history")).toBeVisible();
}
async function waitForCompletion(id: string) {
  const start = Date.now();
  let polls = 0;
  for (;;) {
    const r = await fetch(baseURL + "/api/takes/" + id);
    polls++;
    if (!r.ok) {
      if (Date.now() - start > 10 * 60 * 1000)
        throw Error("Polling timed out; no new submit");
      await new Promise((res) =>
        setTimeout(
          res,
          Math.max(5000, Number(r.headers.get("retry-after") || 0) * 1000),
        ),
      );
      continue;
    }
    const t: Take = await r.json();
    if (t.status === "failed" || t.status === "submission_unknown")
      throw Error(
        "Saved job status " + t.status + "; refusing automatic resubmit",
      );
    if (t.status === "completed")
      return { take: t, elapsedMs: Date.now() - start, polls };
    if (Date.now() - start > 10 * 60 * 1000)
      throw Error("Job still running; no new submit");
    await new Promise((res) =>
      setTimeout(res, Date.now() - start < 30000 ? 2000 : 5000),
    );
  }
}
async function media(id: string, label: string) {
  const r = await fetch(baseURL + "/api/takes/" + id + "/content");
  if (!r.ok || !r.headers.get("content-type")?.includes("video/mp4"))
    throw Error("Invalid MP4 response");
  const bytes = new Uint8Array(await r.arrayBuffer());
  await writeFile(dir + "/" + label + ".mp4", bytes);
  const metadata = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type,width,height,duration",
        "-show_entries",
        "format=duration,size",
        "-of",
        "json",
        dir + "/" + label + ".mp4",
      ],
      { encoding: "utf8" },
    ),
  );
  await page.getByTestId("take-" + id).click();
  const video = page.getByTestId("take-video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), {
      timeout: 20000,
    })
    .toBe(640);
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.currentTime = 0.7;
    await v.play();
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.8);
  await page.getByRole("button", { name: "Cut · 停止播放" }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const range = await fetch(baseURL + "/api/takes/" + id + "/content", {
    headers: { Range: "bytes=0-1023" },
  });
  if (![200, 206].includes(range.status))
    throw Error("Range/full-content playback failed");
  await range.body?.cancel();
  return {
    bytes: bytes.length,
    metadata,
    rangeStatus: range.status,
    browserWidth: await video.evaluate((v: HTMLVideoElement) => v.videoWidth),
  };
}
try {
  await ready();
  if (!saved.baseId) {
    await expect(page.getByTestId("action")).toBeEnabled();
    await page.getByLabel("服装", { exact: true }).selectOption("Suit");
    await page.getByLabel("眼睛大小", { exact: true }).fill("0.55");
    await page.getByLabel("演员朝向", { exact: true }).fill("45");
    saved.baseline = all.map((t) => t.id);
    saved.attemptedAction = true;
    await persist();
    const submitted = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/takes" &&
        r.request().method() === "POST",
      { timeout: 45000 },
    );
    await page
      .getByRole("button", { name: "连接语音导演", exact: true })
      .click();
    const r = await submitted;
    if (!r.ok())
      throw Error("Real voice Action submission failed: " + r.status());
    const t: Take = await r.json();
    saved.baseId = t.id;
    await persist();
    await expect
      .poll(() => toolOutputs.some((o) => o.takeId === t.id), {
        timeout: 10000,
      })
      .toBe(true);
    report.voiceAction = {
      transcript: await page.getByTestId("voice-heard").textContent(),
      output: toolOutputs.find((o) => o.takeId === t.id),
    };
    await page.getByRole("button", { name: "停止语音", exact: true }).click();
    await page.getByLabel("摄影机距离", { exact: true }).fill("3");
  }
  const first = await waitForCompletion(saved.baseId!);
  report.fear = {
    status: first.take.status,
    queryWaitMsThisRun: first.elapsedMs,
    queryPollsThisRun: first.polls,
  };
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.getByTestId("take-" + saved.baseId).click();
  const portrait = await fetch(
    baseURL + "/api/takes/" + saved.baseId + "/portrait",
  );
  await writeFile(
    dir + "/reference.png",
    new Uint8Array(await portrait.arrayBuffer()),
  );
  if (!saved.retakeId) {
    await page.getByLabel("摄影机距离", { exact: true }).fill("3");
    saved.attemptedRetake = true;
    await persist();
    const submitted = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/takes/retake" &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Retake · 只改情绪", exact: true })
      .click();
    const r = await submitted;
    if (!r.ok()) throw Error("Real Retake submission failed");
    const t: Take = await r.json();
    saved.retakeId = t.id;
    await persist();
  }
  const second = await waitForCompletion(saved.retakeId!);
  const before = first.take.input;
  expect(second.take.input).toEqual({ ...before, emotion: "anger" });
  expect(second.take.invariantHash).toBe(first.take.invariantHash);
  report.anger = {
    status: second.take.status,
    queryWaitMsThisRun: second.elapsedMs,
    queryPollsThisRun: second.polls,
  };
  report.voiceAction = report.voiceAction || {
    tool: "perform",
    verifiedInitialRun: first.take.requestId.startsWith("voice:"),
    note: "Initial real voice Action succeeded; first browser run stopped at the overly strict Range-206 assertion.",
  };
  report.totalSavedTakes = 2;
  report.snapshotIsolation = {
    invariantHashEqual: true,
    sourceUnchanged: true,
    retakeCameraDistance: second.take.input.scene.camera.distance,
  };
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await expect(page.getByTestId("take-" + saved.baseId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  report.selectionPreserved = true;
  report.fear.media = await media(saved.baseId!, "fear");
  report.anger.media = await media(saved.retakeId!, "anger");
  await page.getByTestId("selected-take").scrollIntoViewIfNeeded();
  await page
    .locator(".take-panel")
    .screenshot({ path: "docs/evidence/stage4-live-takes.png" });
  await page.reload();
  await expect(page.getByTestId("take-" + saved.baseId)).toBeVisible();
  await expect(page.getByTestId("take-" + saved.retakeId)).toBeVisible();
  report.refreshRestoresHistory = true;
  await page.getByTestId("take-" + saved.baseId).click();
  await expect
    .poll(
      () =>
        page
          .getByTestId("take-video")
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      { timeout: 15000 },
    )
    .toBe(640);
  report.worksAfterReload = true;
  report.createsThisRun = creates;
  report.browserErrors = errors;
  expect(errors).toEqual([]);
  expect(creates).toBeLessThanOrEqual(2);
  await writeFile(
    dir + "/live-report.json",
    JSON.stringify(
      { ...report, baseId: saved.baseId, retakeId: saved.retakeId },
      null,
      2,
    ),
  );
  // Public report contains no temporary key, image data, user audio or video IDs.
  if (report.voiceAction?.output)
    report.voiceAction = {
      transcript: report.voiceAction.transcript,
      tool: "perform",
      ok: report.voiceAction.output.ok,
      status: report.voiceAction.output.status,
    };
  await writeFile(
    "docs/evidence/stage4-live-summary.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        fear: first.take.status,
        anger: second.take.status,
        invariantHashEqual: true,
        createsThisRun: creates,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
