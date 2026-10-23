import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

import type { Take } from "../../src/domain/take";
const scene = async (page: Page) =>
  JSON.parse((await page.getByTestId("scene-state").textContent())!);
async function prepare(page: Page) {
  const records: Take[] = [],
    requests: any[] = [],
    outputs: any[] = [];
  let ws: WebSocketRoute | undefined;
  const portraits = new Map<string, string>();
  const fixture = (input: any, base?: Take): Take => ({
    id: randomUUID(),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
    baseTakeId: base?.id || null,
    status: "queued",
    videoId: "video_" + records.length,
    progress: 0,
    error: null,
    input: base
      ? { ...structuredClone(base.input), emotion: input.overrides.emotion }
      : {
          scene: input.scene,
          emotion: input.scene.performance.emotion,
          voice: "default",
          model: "higgs-avatar",
          ttsModel: "higgs-tts-3",
          size: "640x640",
          reference: {
            hash: "fixture-reference",
            version: "portrait-v1",
            mode: "captured",
            appearanceKey: JSON.stringify([
              input.scene.actor.presetId,
              input.scene.actor.outfit,
              input.scene.actor.appearance.EyeSize,
              input.scene.actor.appearance.FaceWidth,
            ]),
          },
        },
    inputHash: "fixture-input",
    invariantHash: base?.invariantHash || "fixture-invariant",
  });
  await page.route("**/api/takes**", async (route) => {
    const url = new URL(route.request().url()),
      parts = url.pathname.split("/").filter(Boolean);
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      requests.push({ path: url.pathname, body });
      const existing = records.find((t) => t.requestId === body.requestId);
      if (existing) return route.fulfill({ status: 202, json: existing });
      const base = records.find((t) => t.id === body.baseTakeId),
        t = fixture(body, base);
      records.unshift(t);
      portraits.set(t.id, base ? portraits.get(base.id)! : body.portrait);
      return route.fulfill({ status: 202, json: t });
    }
    if (parts.length === 2) return route.fulfill({ json: { takes: records } });
    const t = records.find((t) => t.id === parts[2]);
    if (!t)
      return route.fulfill({
        status: 404,
        json: { error: { message: "missing" } },
      });
    if (parts[3] === "portrait")
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(portraits.get(t.id)!.split(",")[1], "base64"),
      });
    if (parts[3] === "content")
      return route.fulfill({
        contentType: "video/mp4",
        body: readFileSync("tests/fixtures/playback.mp4"),
      });
    return route.fulfill({ json: t });
  });
  await page.route("**/api/realtime/session", (r) =>
    r.fulfill({
      json: { value: "bai-eph-fixture", expires_at: Date.now() / 1000 + 300 },
    }),
  );
  await page.routeWebSocket("wss://api.boson.ai/v1/realtime", (socket) => {
    ws = socket;
    socket.onMessage((raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === "session.update")
        socket.send(
          JSON.stringify({
            type: e.session.model ? "session.created" : "session.updated",
          }),
        );
      if (e.item?.type === "function_call_output")
        outputs.push(JSON.parse(e.item.output));
      if (e.type === "response.create") {
        const id = "reply-" + outputs.length;
        socket.send(
          JSON.stringify({ type: "response.created", response: { id } }),
        );
        socket.send(
          JSON.stringify({
            type: "response.done",
            response: { id, status: "completed", output: [] },
          }),
        );
      }
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  await expect(page.getByTestId("action")).toBeEnabled();
  return {
    records,
    requests,
    portraits,
    outputs,
    event: (value: unknown) => ws!.send(JSON.stringify(value)),
    emit: (responseId: string, callId: string, name: string, args: unknown) => {
      ws!.send(
        JSON.stringify({
          type: "response.created",
          response: { id: responseId },
        }),
      );
      ws!.send(
        JSON.stringify({
          type: "response.done",
          response: {
            id: responseId,
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: callId,
                name,
                arguments: JSON.stringify(args),
              },
            ],
          },
        }),
      );
    },
    complete: (t: Take) => {
      t.status = "completed";
      t.progress = 100;
    },
  };
}
test("B13/B17: voice Action freezes rendered appearance; emotion-only Retake uses the historical camera", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await prepare(page);
  await page.getByLabel("服装", { exact: true }).selectOption("Suit");
  await page.getByLabel("眼睛大小", { exact: true }).fill("0.75");
  const before = await scene(page);
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  f.emit("action-response", "action-call", "perform", {});
  await expect(
    page.getByTestId("take-history").locator(".take-card"),
  ).toHaveCount(1);
  await expect.poll(() => f.outputs.length).toBe(1);
  expect(f.outputs[0].takeId).toBe(f.records[0].id);
  const frozen = structuredClone(f.records[0]);
  expect(f.requests[0].body.scene.actor.outfit).toBe("Suit");
  expect(f.requests[0].body.scene.actor.appearance.EyeSize).toBe(0.75);
  expect(f.requests[0].body.portrait).toMatch(/^data:image\/png;base64,/);
  mkdirSync("test-results/evidence", { recursive: true });
  writeFileSync(
    "test-results/evidence/stage4-reference.png",
    Buffer.from(f.requests[0].body.portrait.split(",")[1], "base64"),
  );
  await page.getByLabel("摄影机距离", { exact: true }).fill("3");
  f.emit("repeated-response", "action-call", "perform", {});
  await expect.poll(() => f.outputs.length).toBe(2);
  expect(f.requests).toHaveLength(1);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.getByTestId("take-" + frozen.id).click();
  f.emit("retake-response", "retake-call", "retake", { emotion: "anger" });
  await expect(
    page.getByTestId("take-history").locator(".take-card"),
  ).toHaveCount(2);
  const next = f.records[0];
  expect(next.baseTakeId).toBe(frozen.id);
  expect(next.input.scene.camera).toEqual(before.camera);
  expect(next.input).toEqual({ ...frozen.input, emotion: "anger" });
  expect((await scene(page)).camera.distance).toBe(3);
  expect(f.records[1].input).toEqual(frozen.input);
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
  expect(errors).toEqual([]);
});
test("B14/B16: double Action, refresh recovery and late completion preserve the selected old Take", async ({
  page,
}) => {
  const f = await prepare(page);
  await page.getByTestId("action").dblclick({ force: true });
  await expect(
    page.getByTestId("take-history").locator(".take-card"),
  ).toHaveCount(1);
  expect(f.requests).toHaveLength(1);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  const old = f.records[0];
  await page.getByTestId("take-" + old.id).click();
  await page
    .getByRole("button", { name: "Retake · 只改情绪", exact: true })
    .click();
  await expect(
    page.getByTestId("take-history").locator(".take-card"),
  ).toHaveCount(2);
  const newId = f.records[0].id;
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await expect(page.getByTestId("take-" + old.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("take-video")).toHaveAttribute(
    "src",
    "/api/takes/" + old.id + "/content",
  );
  await page.reload();
  await expect(
    page.getByTestId("take-history").locator(".take-card"),
  ).toHaveCount(2);
  await expect(page.getByTestId("selected-take")).toHaveCount(0);
  await page.getByTestId("take-" + newId).click();
  await expect(page.getByTestId("take-video")).toHaveAttribute(
    "src",
    "/api/takes/" + newId + "/content",
  );
  expect(f.requests).toHaveLength(2);
});
test("B15: switching historical playback and Cut pause previous media; restoring is explicit", async ({
  page,
}) => {
  const f = await prepare(page);
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(1);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  const old = f.records[0];
  await page.getByTestId("take-" + old.id).click();
  await page
    .getByRole("button", { name: "Retake · 只改情绪", exact: true })
    .click();
  await expect.poll(() => f.records.length).toBe(2);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  const current = await scene(page);
  await page
    .getByTestId("take-video")
    .evaluate(async (el: HTMLVideoElement) => {
      (window as any).oldVideo = el;
      await el.play();
    });
  await expect
    .poll(() =>
      page
        .getByTestId("take-video")
        .evaluate((el: HTMLVideoElement) => el.paused),
    )
    .toBe(false);
  await page.getByTestId("take-" + f.records[0].id).click();
  expect(await page.evaluate(() => (window as any).oldVideo.paused)).toBe(true);
  expect(await scene(page)).toEqual(current);
  await page
    .getByTestId("take-video")
    .evaluate(async (el: HTMLVideoElement) => {
      await el.play();
    });
  await page.getByRole("button", { name: "Cut · 停止播放" }).click();
  expect(
    await page
      .getByTestId("take-video")
      .evaluate((el: HTMLVideoElement) => el.paused),
  ).toBe(true);
  await page.getByLabel("摄影机距离", { exact: true }).fill("3");
  await page.getByRole("button", { name: "恢复此 Take 的片场" }).click();
  await expect
    .poll(async () => (await scene(page)).camera.distance)
    .toBe(old.input.scene.camera.distance);
  await page
    .getByTestId("take-video")
    .evaluate(async (el: HTMLVideoElement) => {
      (window as any).oldVideo = el;
      await el.play();
    });
  await page.getByRole("link", { name: "能力验证 / Lab ↗" }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await expect
    .poll(() => page.evaluate(() => (window as any).oldVideo.paused))
    .toBe(true);
});
test("B16/A19: unknown submission blocks new fees; completed media failure has a read-only reload", async ({
  page,
}) => {
  const f = await prepare(page);
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(1);
  const t = f.records[0];
  t.status = "submission_unknown";
  t.videoId = null;
  t.error = "提交结果未知，先到 Boson 核实。";
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.reload();
  await expect(page.getByTestId("action")).toBeDisabled();
  await page.getByTestId("take-" + t.id).click();
  await expect(page.getByLabel("已确认的 Boson 视频 ID")).toBeVisible();
  expect(f.requests).toHaveLength(1);
  f.complete(t);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.route("**/api/takes/*/content", (r) =>
    r.fulfill({ status: 404, json: { error: { message: "expired" } } }),
  );
  await page
    .getByTestId("take-video")
    .evaluate((v: HTMLVideoElement) => v.load());
  await expect(
    page.getByRole("button", { name: "重新加载视频" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新加载视频" }).click();
  expect(f.requests).toHaveLength(1);
});

test("B17: a front portrait is independent of staging, but changes when appearance and outfit change", async ({
  page,
}) => {
  const f = await prepare(page);
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(1);
  const first = f.requests[0].body.portrait;
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.getByLabel("摄影机距离", { exact: true }).fill("3");
  await page.getByLabel("演员朝向", { exact: true }).fill("90");
  await page.getByLabel("主光", { exact: true }).fill("0");
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(2);
  expect(f.requests[1].body.portrait).toBe(first);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.getByLabel("服装", { exact: true }).selectOption("Suit");
  await page.getByLabel("眼睛大小", { exact: true }).fill("0.9");
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(3);
  expect(f.requests[2].body.portrait).not.toBe(first);
});
test("B15: voice Cut stops both a real media element and Web Audio, suppressing late reply audio", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start,
      stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<typeof start>
    ) {
      (window as any).takeAudioStarts =
        ((window as any).takeAudioStarts || 0) + 1;
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (
      ...args: Parameters<typeof stop>
    ) {
      (window as any).takeAudioStops =
        ((window as any).takeAudioStops || 0) + 1;
      return stop.apply(this, args);
    };
  });
  const f = await prepare(page);
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(1);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await page.getByTestId("take-" + f.records[0].id).click();
  await page
    .getByTestId("take-video")
    .evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  f.event({ type: "response.created", response: { id: "audio-reply" } });
  const audio = {
    type: "response.output_audio.delta",
    response_id: "audio-reply",
    item_id: "audio-item",
    content_index: 0,
    delta: Buffer.alloc(480000).toString("base64"),
  };
  f.event(audio);
  await expect
    .poll(() => page.evaluate(() => (window as any).takeAudioStarts || 0))
    .toBeGreaterThan(0);
  f.emit("cut-response", "cut-call", "stop_playback", {});
  await expect.poll(() => f.outputs.length).toBe(1);
  expect(
    await page
      .getByTestId("take-video")
      .evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as any).takeAudioStops || 0),
  ).toBeGreaterThan(0);
  const starts = await page.evaluate(() => (window as any).takeAudioStarts);
  f.event(audio);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).takeAudioStarts)).toBe(
    starts,
  );
  expect(f.outputs[0].message).toContain("云端任务继续");
  expect(f.requests).toHaveLength(1);
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
});
