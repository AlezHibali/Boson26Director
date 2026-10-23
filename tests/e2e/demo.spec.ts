import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { prepare } from "./support/take-fixture";
const state = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.getByTestId("scene-state").textContent())!);
test("B18/B19: three rehearsal rounds release microphone, reset deterministically and label saved playback", async ({
  page,
  browserName,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.name));
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (c) => {
      const stream = await original(c);
      ((window as any).allDemoTracks ||= []).push(...stream.getTracks());
      return stream;
    };
  });
  const f = await prepare(page);
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(1);
  f.complete(f.records[0]);
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  const id = f.records[0].id;
  await page.getByTestId("take-" + id).click();
  await page.getByRole("button", { name: "保存本地回放", exact: true }).click();
  await expect(page.getByTestId("take-" + id)).toContainText("本地归档");
  const snapshots: any[] = [];
  for (let round = 0; round < 3; round++) {
    await page.getByTestId("take-" + id).click();
    await page.getByTestId("take-video").evaluate((v: HTMLVideoElement) => {
      (window as any).previousDemoVideo = v;
      return v.play();
    });
    await page
      .getByRole("button", { name: "连接语音导演", exact: true })
      .click();
    await expect(page.getByTestId("voice-status")).toContainText("已连接");
    await page.getByLabel("演员朝向", { exact: true }).fill(String(round * 20));
    await page.getByLabel("摄影机距离", { exact: true }).fill("3");
    await page.getByTestId("prepare-demo").click();
    await expect(page.getByTestId("demo-status")).toContainText("预设就绪");
    await expect(
      page.getByRole("button", { name: "连接语音导演", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() =>
        (window as any).allDemoTracks.every(
          (t: MediaStreamTrack) => t.readyState === "ended",
        ),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as any).previousDemoVideo.paused),
    ).toBe(true);
    const s = await state(page);
    delete s.revision;
    delete s.actor.animation.token;
    snapshots.push(s);
    expect(s.actor.rotationY).toBe(45);
    expect(s.actor.outfit).toBe("Suit");
    expect(s.camera.distance).toBe(5.2);
    await expect(page.getByTestId("take-" + id)).toContainText("预生成");
    expect(f.requests).toHaveLength(1); // Only the explicitly mocked initial Action.
  }
  expect(snapshots[1]).toEqual(snapshots[0]);
  expect(snapshots[2]).toEqual(snapshots[0]);
  expect(errors).toEqual([]);
  const dir =
    process.env.STAGE5_EVIDENCE === "1"
      ? "docs/evidence"
      : "test-results/evidence";
  mkdirSync(dir, { recursive: true });
  await page
    .locator(".studio-demo")
    .screenshot({ path: dir + "/stage5-demo-" + info.project.name + ".png" });
  writeFileSync(
    dir + "/stage5-rehearsal-" + info.project.name + ".json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: info.project.name,
        version: browser.version(),
        mode: "HTTP/WS fixtures, real WebGL and Web Audio, synthetic microphone",
        rounds: 3,
        matchingSnapshots: true,
        tracksEnded: true,
        previousVideoPaused: true,
        preGeneratedLabel: true,
        mockedSubmissions: f.requests.length,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  info.annotations.push({
    type: "environment",
    description:
      browserName +
      " / " +
      info.project.name +
      "; synthetic mic and fixture services",
  });
});
test("B20: microphone refusal and generation failure retain manual recovery; preparation keeps running tasks", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  const f = await prepare(page);
  await page.getByRole("button", { name: "连接语音导演", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "连接语音导演", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("摄影机距离", { exact: true }).fill("3");
  expect((await state(page)).camera.distance).toBe(3);
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(1);
  const t = f.records[0];
  await page.getByTestId("prepare-demo").click();
  await expect(page.getByTestId("demo-status")).toContainText("预设就绪");
  expect(t.status).toBe("queued");
  await expect(page.getByTestId("action")).toBeDisabled();
  expect(f.requests).toHaveLength(1);
  t.status = "failed";
  t.error = "Fixture generation failed; user can explicitly create a new Take.";
  await page.getByRole("button", { name: "检查记录 / 继续查询" }).click();
  await expect(page.getByTestId("action")).toBeEnabled();
  await page.getByTestId("take-" + t.id).click();
  await expect(page.getByTestId("selected-take")).toContainText(
    "Fixture generation failed",
  );
  await page.getByTestId("action").click();
  await expect.poll(() => f.records.length).toBe(2);
  expect(f.requests).toHaveLength(2);
});
