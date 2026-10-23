import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { SceneState } from "../../src/domain/scene";
const scene = async (page: Page): Promise<SceneState> =>
  JSON.parse((await page.getByTestId("scene-state").textContent())!);
async function prepare(page: Page) {
  let mints = 0;
  const sockets: WebSocketRoute[] = [];
  const messages: Record<string, any>[][] = [];
  await page.route("**/api/realtime/session", (route) =>
    route.fulfill({
      json: {
        value: "bai-eph-voice-" + ++mints,
        expires_at: Date.now() / 1000 + 300,
      },
    }),
  );
  await page.routeWebSocket("wss://api.boson.ai/v1/realtime", (ws) => {
    const index = sockets.length;
    sockets.push(ws);
    messages.push([]);
    let replies = 0;
    ws.onMessage((raw) => {
      const value = JSON.parse(raw.toString());
      messages[index].push(value);
      if (value.type === "session.update")
        ws.send(
          JSON.stringify({
            type: value.session.model ? "session.created" : "session.updated",
          }),
        );
      if (value.type === "response.create") {
        const id = "reply-" + index + "-" + ++replies;
        ws.send(JSON.stringify({ type: "response.created", response: { id } }));
        ws.send(
          JSON.stringify({
            type: "response.output_audio_transcript.delta",
            response_id: id,
            delta: "已按实际结果处理。",
          }),
        );
        ws.send(
          JSON.stringify({
            type: "response.done",
            response: { id, status: "completed", output: [] },
          }),
        );
      }
    });
  });
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      const view = window as unknown as {
        voiceTracks: MediaStreamTrack[];
        micOpens: number;
      };
      view.voiceTracks = stream.getTracks();
      view.micOpens = (view.micOpens || 0) + 1;
      return stream;
    };
    const originalStart = AudioBufferSourceNode.prototype.start;
    const originalStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<typeof originalStart>
    ) {
      const w = window as unknown as { voiceStarts: number };
      w.voiceStarts = (w.voiceStarts || 0) + 1;
      return originalStart.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (
      ...args: Parameters<typeof originalStop>
    ) {
      const w = window as unknown as { voiceStops: number };
      w.voiceStops = (w.voiceStops || 0) + 1;
      return originalStop.apply(this, args);
    };
  });
  await page.goto("/");
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  return {
    sockets,
    messages,
    get mints() {
      return mints;
    },
  };
}
function emitCall(
  ws: WebSocketRoute,
  id: string,
  callId: string,
  name: string,
  args: unknown,
) {
  ws.send(JSON.stringify({ type: "response.created", response: { id } }));
  ws.send(
    JSON.stringify({
      type: "response.done",
      response: {
        id,
        status: "completed",
        output: [
          {
            type: "function_call",
            executor: "client",
            call_id: callId,
            name,
            arguments: JSON.stringify(args),
          },
        ],
      },
    }),
  );
}
test("B9/B12: complete speech tool calls update real 3D state, deduplicate, and follow manual changes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await prepare(page);
  await page
    .getByRole("button", { name: "连接语音导演", exact: true })
    .dblclick({ force: true });
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  expect(f.mints).toBe(1);
  const ws = f.sockets[0];
  ws.send(
    JSON.stringify({
      type: "response.function_call_arguments.delta",
      call_id: "c1",
      delta: '{"commands":',
    }),
  );
  ws.send(
    JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      arguments: '{"incomplete":true}',
    }),
  );
  expect((await scene(page)).revision).toBe(0);
  ws.send(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "向右转45度并挥手",
    }),
  );
  const command = {
    commands: [
      {
        type: "rotate_actor",
        actorId: "actor-1",
        mode: "relative",
        degrees: 45,
      },
      { type: "play_animation", actorId: "actor-1", animation: "Wave" },
    ],
  };
  emitCall(ws, "r1", "c1", "batch_commands", command);
  await expect.poll(async () => (await scene(page)).actor.rotationY).toBe(45);
  await expect(page.getByTestId("voice-heard")).toContainText("转45度");
  await expect
    .poll(
      () =>
        f.messages[0].filter((e) => e.item?.type === "function_call_output")
          .length,
    )
    .toBe(1);
  const result = f.messages[0].find((e) => e.item?.call_id === "c1");
  expect(JSON.parse(result!.item.output).ok).toBe(true);
  emitCall(ws, "r2", "c1", "batch_commands", command);
  await expect
    .poll(
      () =>
        f.messages[0].filter((e) => e.item?.type === "function_call_output")
          .length,
    )
    .toBe(2);
  expect((await scene(page)).actor.rotationY).toBe(45);
  await expect(page.getByTestId("animation-status")).toHaveText("Idle", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "右转 45° →", exact: true }).click();
  await expect
    .poll(() =>
      f.messages[0].some(
        (e) =>
          e.type === "session.update" &&
          e.session.instructions.includes('"rotationY":90'),
      ),
    )
    .toBe(true);
  emitCall(ws, "r3", "c3", "rotate_actor", {
    actorId: "actor-1",
    mode: "relative",
    degrees: -45,
  });
  await expect.poll(async () => (await scene(page)).actor.rotationY).toBe(45);
  const before = await scene(page);
  emitCall(ws, "r4", "bad", "batch_commands", {
    commands: [
      { type: "orbit", degrees: 15 },
      { type: "set_outfit", actorId: "actor-1", outfit: "Dragon" },
    ],
  });
  await expect
    .poll(() => f.messages[0].some((e) => e.item?.call_id === "bad"))
    .toBe(true);
  expect(await scene(page)).toEqual(before);
  await page.locator(".voice-tool-details summary").first().click();
  mkdirSync("docs/evidence", { recursive: true });
  await page.screenshot({
    path: "docs/evidence/stage3-voice-director.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { voiceTracks: MediaStreamTrack[] }
      ).voiceTracks.every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("B10: actual Web Audio stops on barge-in, truncates heard duration, suppresses late audio", async ({
  page,
}) => {
  const f = await prepare(page);
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  const ws = f.sockets[0];
  ws.send(
    JSON.stringify({ type: "response.created", response: { id: "speaking" } }),
  );
  ws.send(
    JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "speaking",
      item_id: "audio-1",
      delta: Buffer.alloc(96000).toString("base64"),
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { voiceStarts: number }).voiceStarts || 0,
      ),
    )
    .toBe(1);
  ws.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { voiceStops: number }).voiceStops || 0,
      ),
    )
    .toBe(1);
  await expect
    .poll(() =>
      f.messages[0].some((e) => e.type === "conversation.item.truncate"),
    )
    .toBe(true);
  const truncate = f.messages[0].find(
    (e) => e.type === "conversation.item.truncate",
  )!;
  expect(truncate.audio_end_ms).toBeGreaterThanOrEqual(0);
  expect(truncate.audio_end_ms).toBeLessThan(2000);
  ws.send(
    JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "speaking",
      item_id: "audio-1",
      delta: Buffer.alloc(4800).toString("base64"),
    }),
  );
  emitCall(ws, "new-turn", "new-call", "orbit", { degrees: 15 });
  await expect.poll(async () => (await scene(page)).camera.azimuth).toBe(15);
  expect(
    await page.evaluate(
      () => (window as unknown as { voiceStarts: number }).voiceStarts,
    ),
  ).toBe(1);
  const runtime = JSON.parse(
    (await page.getByTestId("voice-runtime").textContent())!,
  );
  expect(runtime.interruptionMs).toBeLessThanOrEqual(300);
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
});
test("B11/A12: stop cancels pending asset writes, reconnect refreshes context, network recovery retains scene", async ({
  page,
  context,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((yes) => (release = yes));
  await page.route("**/actors/ren.glb", async (route) => {
    await waiting;
    await route.continue();
  });
  const f = await prepare(page);
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  emitCall(f.sockets[0], "old", "old-call", "select_actor", {
    actorId: "actor-1",
    presetId: "ren",
  });
  await expect(page.getByTestId("asset-load-status")).toContainText("正在加载");
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
  release();
  await page.waitForTimeout(300);
  expect((await scene(page)).actor.presetId).toBe("mira");
  await page.getByLabel("服装", { exact: true }).selectOption("Suit");
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  expect(f.mints).toBe(2);
  expect(f.messages[1][0].session.instructions).toContain('"outfit":"Suit"');
  await context.setOffline(true);
  await expect(page.getByTestId("voice-status")).toContainText("离线");
  await context.setOffline(false);
  await expect.poll(() => f.mints).toBe(3);
  await expect(page.getByTestId("voice-status")).toContainText("已连接");
  expect((await scene(page)).actor.outfit).toBe("Suit");
  expect(
    await page.evaluate(
      () => (window as unknown as { micOpens: number }).micOpens,
    ),
  ).toBe(2);
  await page.getByRole("button", { name: "停止语音", exact: true }).click();
});
test("B11: microphone permission rejection leaves retry available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(page.getByTestId("voice-status")).toContainText("权限被拒绝");
  await expect(
    page.getByRole("button", { name: "连接语音导演", exact: true }),
  ).toBeEnabled();
});
