import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import type { SceneState } from "../../src/domain/scene";
import type { RenderInfo } from "../../src/studio/stage-view";
const state = async (page: Page): Promise<SceneState> =>
  JSON.parse((await page.getByTestId("scene-state").textContent())!);
const rendered = async (page: Page): Promise<RenderInfo> =>
  JSON.parse((await page.getByTestId("render-state").textContent())!);
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  await expect
    .poll(async () => (await rendered(page))?.actors, { timeout: 15000 })
    .toBe(1);
}
async function runCommand(page: Page, value: unknown) {
  const details = page.locator(".studio-diagnostics");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  await page
    .getByLabel("导演命令 JSON")
    .fill(typeof value === "string" ? value : JSON.stringify(value));
  await page.getByRole("button", { name: "执行命令", exact: true }).click();
}
test("B5: complete manual director path changes actual actor, camera and lights", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  mkdirSync("docs/evidence", { recursive: true });
  await page.screenshot({
    path: "docs/evidence/stage2-studio.png",
    fullPage: true,
  });
  const initial = await state(page);
  await page
    .getByLabel("台词", { exact: true })
    .fill("Keep the staging. Change the performance.");
  await page.getByRole("button", { name: "愤怒", exact: true }).click();
  await page.getByRole("button", { name: /Ren/ }).click();
  await expect(page.getByTestId("active-actor")).toContainText("Ren");
  const switched = await state(page);
  expect(switched.actor.id).toBe(initial.actor.id);
  expect(switched.camera).toEqual(initial.camera);
  expect(switched.lights).toEqual(initial.lights);
  expect(switched.performance.dialogue).toContain("Keep the staging.");
  await page.getByLabel("服装", { exact: true }).selectOption("Suit");
  await page.getByLabel("眼睛大小", { exact: true }).fill("0.85");
  await page.getByLabel("脸部宽度", { exact: true }).fill("0.6");
  await expect
    .poll(async () => (await rendered(page)).morphs.EyeSize)
    .toBe(0.85);
  await page.getByRole("button", { name: "右转 45° →", exact: true }).click();
  await page.getByRole("button", { name: "挥手 / Wave", exact: true }).click();
  await expect(page.getByTestId("animation-status")).toHaveText("Wave");
  await expect(page.getByTestId("animation-status")).toHaveText("Idle", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "特写", exact: true }).click();
  await page.getByRole("button", { name: "推近 +", exact: true }).click();
  await page.getByRole("button", { name: "调暗灯光", exact: true }).click();
  const final = await state(page);
  expect(final.actor).toMatchObject({
    presetId: "ren",
    outfit: "Suit",
    rotationY: 45,
    appearance: { EyeSize: 0.85, FaceWidth: 0.6 },
  });
  expect(final.camera.distance).toBe(2.2);
  expect(final.lights.key).toBeLessThan(initial.lights.key);
  expect(final.performance.emotion).toBe("anger");
  await expect
    .poll(async () => (await rendered(page)).camera.fov)
    .toBeCloseTo(30, 1);
  await expect
    .poll(async () => (await rendered(page)).loadedPreset)
    .toBe("ren");
  await page.screenshot({
    path: "docs/evidence/stage2-directed.png",
    fullPage: true,
  });
  // Fix actor pose for a clear before/after geometry comparison.
  await page.getByLabel("演员朝向", { exact: true }).fill("0");
  await page.getByLabel("眼睛大小", { exact: true }).fill("0");
  await expect.poll(async () => (await rendered(page)).morphs.EyeSize).toBe(0);
  const before = await page
    .getByTestId("stage-viewport")
    .screenshot({ path: "docs/evidence/stage2-morph-before.png" });
  await page.getByLabel("眼睛大小", { exact: true }).fill("1");
  await expect.poll(async () => (await rendered(page)).morphs.EyeSize).toBe(1);
  const after = await page
    .getByTestId("stage-viewport")
    .screenshot({ path: "docs/evidence/stage2-morph-after.png" });
  expect(after).not.toEqual(before);
  expect(errors).toEqual([]);
});
test("B6: late actor load, repeated Wave and rapid morph edits never duplicate or roll back", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let intercepted = false;
  await page.route("**/actors/ren.glb", async (route) => {
    intercepted = true;
    await hold;
    await route.continue();
  });
  await ready(page);
  await page.getByRole("button", { name: /Ren/ }).click();
  await expect.poll(() => intercepted).toBe(true);
  expect((await state(page)).actor.presetId).toBe("mira");
  await page.getByRole("button", { name: /Mira/ }).click();
  release();
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪");
  await page.waitForTimeout(700);
  expect((await state(page)).actor.presetId).toBe("mira");
  const token = (await state(page)).actor.animation.token;
  for (let i = 0; i < 3; i++)
    await page
      .getByRole("button", { name: "挥手 / Wave", exact: true })
      .click();
  expect((await state(page)).actor.animation.token).toBe(token + 3);
  for (const value of ["0", "0.2", "0.8", "1"])
    await page.getByLabel("眼睛大小", { exact: true }).fill(value);
  await expect(page.getByTestId("animation-status")).toHaveText("Idle", {
    timeout: 10000,
  });
  await expect.poll(async () => (await rendered(page)).morphs.EyeSize).toBe(1);
  await expect.poll(async () => (await rendered(page)).animation).toBe("Idle");
  const visual = await rendered(page);
  expect(visual.actors).toBe(1);
  expect(visual.loadedPreset).toBe("mira");
  expect(visual.animation).toBe("Idle");
});
test("B7: failed actor load retains working scene and can retry without resetting camera", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/actors/ren.glb", (route) =>
    fail ? route.abort("failed") : route.continue(),
  );
  await ready(page);
  const before = await state(page);
  await page.getByRole("button", { name: /Ren/ }).click();
  await expect(page.getByTestId("asset-load-status")).toContainText("加载失败");
  expect(await state(page)).toEqual(before);
  await expect
    .poll(async () => (await rendered(page)).loadedPreset)
    .toBe("mira");
  await page.getByRole("button", { name: "环绕 15° →", exact: true }).click();
  expect((await state(page)).camera.azimuth).toBe(15);
  fail = false;
  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(page.getByTestId("active-actor")).toContainText("Ren");
  expect((await state(page)).camera.azimuth).toBe(15);
});
test("A6/A9 browser command entry rejects unsupported operations and commits valid batch once", async ({
  page,
}) => {
  await ready(page);
  const initial = await state(page);
  await runCommand(page, {
    type: "batch",
    commands: [
      {
        type: "rotate_actor",
        actorId: "actor-1",
        mode: "relative",
        degrees: 45,
      },
      { type: "set_outfit", actorId: "actor-1", outfit: "Dragon" },
    ],
  });
  await expect(page.getByTestId("command-feedback")).toContainText(
    "不支持服装",
  );
  expect(await state(page)).toEqual(initial);
  await runCommand(page, "{broken");
  await expect(page.getByTestId("command-feedback")).toContainText("JSON");
  expect(await state(page)).toEqual(initial);
  await runCommand(page, {
    type: "batch",
    commands: [
      { type: "set_camera", camera: { distance: 3.6 } },
      { type: "set_lighting", lights: { key: 2 } },
    ],
  });
  const next = await state(page);
  expect(next.revision).toBe(initial.revision + 1);
  expect(next.camera.distance).toBe(3.6);
  expect(next.lights.key).toBe(2);
  await runCommand(page, { type: "set_camera", camera: { distance: 2.2 } });
  const atBoundary = await state(page);
  await page.getByRole("button", { name: "推近 +", exact: true }).click();
  await expect(page.getByTestId("command-feedback")).toContainText("2.2–6");
  expect(await state(page)).toEqual(atBoundary);
  await page.getByRole("button", { name: "重置片场", exact: true }).click();
  await expect.poll(async () => (await state(page)).camera.distance).toBe(5.2);
});
test("B8: 1280x720 and 1920x1080 layout and measured renderer performance", async ({
  page,
}) => {
  test.setTimeout(90000);
  const report: { environment: unknown; samples: unknown[] } = {
    environment: {
      cpu: cpus()[0].model,
      os: platform() + " " + release(),
      browser: "Chromium / Playwright",
      rendering: "Actual WebGL, selected adapter reported below",
    },
    samples: [],
  };
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await ready(page);
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByLabel("摄影机距离", { exact: true })).toBeVisible();
    const samples: number[] = [];
    let info = await rendered(page);
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(1050);
      info = await rendered(page);
      samples.push(info.fps);
      await page
        .getByLabel("环绕角度", { exact: true })
        .fill(String([0, 15, -15, 30, 0][i]));
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    report.samples.push({
      viewport: size,
      renderer: info.renderer,
      fps: samples,
      median,
      drawCalls: info.drawCalls,
      actors: info.actors,
    });
    mkdirSync("docs/evidence", { recursive: true });
    writeFileSync(
      "docs/evidence/stage2-performance.json",
      JSON.stringify(report, null, 2),
    );
    await page.screenshot({
      path: "docs/evidence/stage2-" + size.width + ".png",
      fullPage: true,
    });
    expect(info.actors).toBe(1);
    expect(median).toBeGreaterThanOrEqual(30);
  }
});
