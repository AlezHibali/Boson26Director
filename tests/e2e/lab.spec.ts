const evidence =
  process.env.UPDATE_EVIDENCE === "1"
    ? "docs/evidence"
    : "test-results/evidence";
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
test("local HTTP diagnostics and invalid inputs do not invoke paid services", async ({
  request,
}) => {
  const response = await request.get("/api/diagnostics");
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.provider).toBe("Boson");
  expect(JSON.stringify(data)).not.toMatch(/bai-/);
  for (const body of [
    {},
    {
      ref_image: "https://docs.boson.ai/public/avatar/sample.jpg",
      input: "https://docs.boson.ai/public/audio/sample.mp3",
      input_tts: { text: "hi" },
    },
  ]) {
    expect((await request.post("/api/avatar", { data: body })).status()).toBe(
      400,
    );
  }
  expect(
    (
      await request.post("/api/voice-preview", {
        data: { text: "<|emotion:anger|>injection" },
      })
    ).status(),
  ).toBe(400);
  expect((await request.get("/api/avatar/invalid")).status()).toBe(400);
});
test("actual WebGL assets, morph pixels, outfit, animation and portrait capture", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/lab");
  await expect(page.getByTestId("capabilities")).toContainText("bones", {
    timeout: 60000,
  });
  await expect(page.getByTestId("capabilities")).toContainText("EyeSize");
  await page.getByRole("button", { name: /Mira/ }).click();
  await expect(
    page.getByRole("button", { name: "截取角色人像" }),
  ).toBeEnabled();
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({
    path: evidence + "/stage1-lab.png",
    fullPage: true,
  });
  const stage = page.getByTestId("actor-stage");
  await page.getByRole("button", { name: "截取角色人像" }).click();
  await page.getByLabel("Avatar 参考人像").selectOption("capture");
  const image = page.getByAltText("当前角色参考人像");
  const before = await image.getAttribute("src");
  const first = await stage.screenshot();
  await page.getByLabel("眼睛大小", { exact: true }).fill("1");
  await page.getByLabel("脸部宽度", { exact: true }).fill("1");
  await expect(page.getByText("外形已变化，请重新截取")).toBeVisible();
  await page.getByRole("button", { name: "截取角色人像" }).click();
  const after = await image.getAttribute("src");
  expect(after).not.toBe(before);
  expect(await stage.screenshot()).not.toEqual(first);
  writeFileSync(
    evidence + "/actor-portrait.png",
    Buffer.from(before!.split(",")[1], "base64"),
  );
  await page.getByLabel("服装", { exact: true }).selectOption("Suit");
  await page.getByLabel("动作", { exact: true }).selectOption("Wave");
  await page.screenshot({
    path: evidence + "/stage1-morph-and-suit.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Ren/ }).click();
  await expect(page.getByTestId("capabilities")).toContainText("bones");
  await page.getByRole("button", { name: /Mira/ }).click();
  await expect(page.getByTestId("capabilities")).toContainText("bones");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("mocked TTS and video are playable; one click creates one job and refresh restores ID", async ({
  page,
}) => {
  let submissions = 0;
  let queries = 0;
  await page.route("**/api/voice-preview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: readFileSync("tests/fixtures/tone.wav"),
    }),
  );
  await page.route("**/api/avatar", async (route) => {
    submissions++;
    await route.fulfill({
      status: 202,
      json: { id: "video_fixture", status: "queued" },
    });
  });
  await page.route("**/api/avatar/video_fixture", (route) =>
    route.fulfill({
      json: {
        id: "video_fixture",
        status: ++queries < 2 ? "in_progress" : "completed",
      },
    }),
  );
  await page.route("**/api/avatar/video_fixture/content", (route) =>
    route.fulfill({
      contentType: "video/mp4",
      body: readFileSync("tests/fixtures/clip.mp4"),
    }),
  );
  await page.goto("/lab");
  await page.getByRole("button", { name: "试听 TTS 3" }).click();
  const audio = page.getByLabel("生成的台词音频");
  await expect(audio).toBeVisible();
  await expect
    .poll(() => audio.evaluate((e: HTMLAudioElement) => e.duration))
    .toBeGreaterThan(0);
  await audio.evaluate((e: HTMLAudioElement) => e.play());
  await expect
    .poll(() => audio.evaluate((e: HTMLAudioElement) => e.currentTime))
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "生成 Avatar 测试视频" })
    .dblclick({ force: true });
  await expect(page.getByTestId("job-state")).toContainText("completed", {
    timeout: 20000,
  });
  expect(submissions).toBe(1);
  const video = page.getByLabel("Avatar 生成视频");
  await expect
    .poll(() => video.evaluate((e: HTMLVideoElement) => e.videoWidth))
    .toBeGreaterThan(0);
  await video.evaluate((e: HTMLVideoElement) => e.play());
  await expect
    .poll(() => video.evaluate((e: HTMLVideoElement) => e.currentTime))
    .toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByLabel("视频任务 ID")).toHaveValue("video_fixture");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByTestId("job-state")).toContainText("completed");
});
test("mic denied is recoverable and unknown paid submission disables repeat", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.route("**/api/avatar", (route) =>
    route.fulfill({
      status: 504,
      json: {
        error: {
          code: "SUBMISSION_UNKNOWN",
          message: "提交结果未知。上游可能已接收，请勿自动重试或重复生成。",
        },
      },
    }),
  );
  await page.goto("/lab");
  await page.getByRole("button", { name: "连接麦克风" }).click();
  await expect(page.getByTestId("realtime-status")).toContainText("权限被拒绝");
  await expect(page.getByRole("button", { name: "连接麦克风" })).toBeEnabled();
  await page.getByRole("button", { name: "生成 Avatar 测试视频" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "提交结果未知" }),
  ).toContainText("提交结果未知");
  await expect(page.getByRole("button", { name: /结果未知 ·/ })).toBeDisabled();
});

test("mocked realtime captures PCM, handles first session.created and releases microphone", async ({
  page,
}) => {
  let appended = 0;
  let truncated = false;
  await page.route("**/api/realtime/session", (route) =>
    route.fulfill({
      json: { value: "bai-eph-fixture", expires_at: 1900000000 },
    }),
  );
  await page.routeWebSocket("wss://api.boson.ai/v1/realtime", (ws) => {
    ws.onMessage((raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === "session.update")
        ws.send(
          JSON.stringify({
            type: "session.created",
            session: { id: "sess_fixture" },
          }),
        );
      if (value.type === "input_audio_buffer.append") {
        appended++;
        expect(Buffer.from(value.audio, "base64").byteLength).toBe(4800);
        if (appended === 1) {
          ws.send(
            JSON.stringify({
              type: "response.output_audio.delta",
              item_id: "item_fixture",
              delta: Buffer.alloc(48000).toString("base64"),
            }),
          );
          setTimeout(
            () =>
              ws.send(
                JSON.stringify({ type: "input_audio_buffer.speech_started" }),
              ),
            100,
          );
        }
      }
      if (value.type === "conversation.item.truncate") {
        truncated = true;
        expect(value.audio_end_ms).toBeLessThanOrEqual(1000);
      }
    });
  });
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      (
        window as unknown as { testMicTracks: MediaStreamTrack[] }
      ).testMicTracks = stream.getTracks();
      return stream;
    };
  });
  await page.goto("/lab");
  await page.getByRole("button", { name: "连接麦克风" }).click();
  await expect.poll(() => appended).toBeGreaterThan(0);
  await expect.poll(() => truncated).toBe(true);
  await page.getByRole("button", { name: "停止连接" }).click();
  await expect(page.getByTestId("realtime-status")).toContainText(
    "麦克风已释放",
  );
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { testMicTracks: MediaStreamTrack[] }
      ).testMicTracks.every((track) => track.readyState === "ended"),
    ),
  ).toBe(true);
});
