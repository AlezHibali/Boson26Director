import { describe, it, expect, vi } from "vitest";
import {
  catalog,
  initialScene,
  transition,
  type Catalog,
} from "../../src/domain/scene";
import { createSceneController } from "../../src/studio/controller";
const actorId = "actor-1";
describe("A6: typed and bounded director commands", () => {
  it.each([
    { type: "select_actor", actorId, presetId: "ren" },
    { type: "set_appearance", actorId, morph: "EyeSize", value: 1 },
    { type: "set_outfit", actorId, outfit: "Suit" },
    { type: "rotate_actor", actorId, mode: "relative", degrees: 45 },
    { type: "rotate_actor", actorId, mode: "absolute", degrees: -180 },
    { type: "set_position", actorId, x: 0.75, z: -0.8 },
    { type: "play_animation", actorId, animation: "Wave" },
    {
      type: "set_camera",
      camera: {
        distance: 2.2,
        azimuth: -60,
        height: 0.8,
        fov: 25,
        targetY: 0.8,
      },
    },
    {
      type: "set_camera",
      camera: { distance: 6, azimuth: 60, height: 3, fov: 65, targetY: 1.8 },
    },
    { type: "dolly", amount: 0.4 },
    { type: "orbit", degrees: 15 },
    {
      type: "set_lighting",
      lights: { key: 0, fill: 4, rim: 6, ambient: 0.05, temperature: "cool" },
    },
    { type: "set_dialogue", text: "Keep this line." },
    { type: "set_emotion", emotion: "anger" },
    { type: "reset_scene" },
  ])("accepts valid $type and advances one revision", (command) => {
    const state = initialScene();
    const snapshot = structuredClone(state);
    const result = transition(state, command);
    expect(result.result.ok).toBe(true);
    expect(result.state.revision).toBe(1);
    expect(state).toEqual(snapshot);
  });
  it.each([
    { type: "select_actor", actorId, presetId: "missing" },
    { type: "set_outfit", actorId: "missing", outfit: "Suit" },
    { type: "set_outfit", actorId, outfit: "Dragon" },
    { type: "set_appearance", actorId, morph: "Nose", value: 0.5 },
    { type: "set_appearance", actorId, morph: "EyeSize", value: 1.1 },
    { type: "set_appearance", actorId, morph: "EyeSize", value: NaN },
    { type: "play_animation", actorId, animation: "Dance" },
    { type: "rotate_actor", actorId, mode: "absolute", degrees: 361 },
    { type: "set_position", actorId, x: 2, z: 0 },
    { type: "set_camera", camera: {} },
    { type: "set_camera", camera: { distance: 2.19 } },
    { type: "set_camera", camera: { fov: 66 } },
    { type: "set_camera", camera: { height: Infinity } },
    { type: "set_lighting", lights: { ambient: 0 } },
    { type: "set_lighting", lights: { key: 7 } },
    { type: "set_dialogue", text: "x".repeat(301) },
    { type: "set_emotion", emotion: "unknown" },
    { type: "dolly", amount: 4 },
    { type: "orbit", degrees: 121 },
    { type: "set_camera", camera: { distance: 4 }, unknown: 1 },
    { type: "unknown" },
  ])("rejects invalid $type without changing state or revision", (command) => {
    const state = initialScene();
    const result = transition(state, command);
    expect(result.result.ok).toBe(false);
    expect(result.state).toBe(state);
    expect(result.state.revision).toBe(0);
  });
  it("enforces derived dolly and orbit bounds without clamping silently", () => {
    const state = initialScene();
    state.camera.distance = 2.2;
    state.camera.azimuth = 60;
    expect(transition(state, { type: "dolly", amount: 0.1 }).state).toBe(state);
    expect(transition(state, { type: "orbit", degrees: 1 }).state).toBe(state);
  });
  it("keeps static appearance separate from dynamic expression", () => {
    const state = initialScene();
    state.actor.expression = { Blink: 0.7 };
    expect(
      transition(state, {
        type: "set_appearance",
        actorId,
        morph: "EyeSize",
        value: 0.9,
      }).state.actor.expression,
    ).toEqual({ Blink: 0.7 });
  });
});
describe("A7: compatible actor replacement and explicit fallback", () => {
  it("preserves stable actor ID, transform, appearance, camera, lights and script", () => {
    const state = initialScene();
    state.actor.position.x = 0.3;
    state.actor.rotationY = 45;
    state.actor.outfit = "Suit";
    state.actor.animation = { name: "Wave", token: 8 };
    state.camera.azimuth = 30;
    state.lights.key = 2;
    state.performance.dialogue = "Same line";
    const next = transition(state, {
      type: "select_actor",
      actorId,
      presetId: "ren",
    });
    const expected = structuredClone(state);
    expected.revision++;
    expected.actor.presetId = "ren";
    expected.actor.animation.token++;
    expect(next.state).toEqual(expected);
    expect(next.result).toMatchObject({ ok: true, notices: [] });
  });
  it("removes unsupported morphs, clamps range, falls back outfit/animation and reports every fallback", () => {
    const assets: Catalog = {
      ...catalog,
      limited: {
        ...catalog.ren,
        id: "limited",
        morphs: { EyeSize: { min: 0.25, max: 0.75 } },
        outfits: ["Casual"],
        animations: ["Idle"],
      },
    };
    const state = initialScene();
    state.actor.appearance.EyeSize = 1;
    state.actor.outfit = "Suit";
    state.actor.animation.name = "Wave";
    const next = transition(
      state,
      { type: "select_actor", actorId, presetId: "limited" },
      assets,
    );
    expect(next.state.actor.appearance).toEqual({ EyeSize: 0.75 });
    expect(next.state.actor.outfit).toBe("Casual");
    expect(next.state.actor.animation.name).toBe("Idle");
    expect(next.result).toMatchObject({
      ok: true,
      notices: expect.arrayContaining([
        expect.stringContaining("FaceWidth"),
        expect.stringContaining("范围"),
        expect.stringContaining("服装"),
        expect.stringContaining("动作"),
      ]),
    });
  });
});
describe("A8/A9: determinism, rotation semantics and atomic batches", () => {
  it("same state and command produce exactly the same result", () => {
    const command = {
      type: "batch",
      commands: [
        { type: "rotate_actor", actorId, mode: "relative", degrees: 45 },
        { type: "set_camera", camera: { distance: 3 } },
      ],
    };
    expect(transition(initialScene(), command)).toEqual(
      transition(initialScene(), command),
    );
  });
  it("relative angles accumulate while absolute angles replace, normalized around world Y", () => {
    const first = transition(initialScene(), {
      type: "rotate_actor",
      actorId,
      mode: "relative",
      degrees: 45,
    }).state;
    expect(
      transition(first, {
        type: "rotate_actor",
        actorId,
        mode: "relative",
        degrees: 45,
      }).state.actor.rotationY,
    ).toBe(90);
    expect(
      transition(first, {
        type: "rotate_actor",
        actorId,
        mode: "absolute",
        degrees: 45,
      }).state.actor.rotationY,
    ).toBe(45);
    expect(
      transition(first, {
        type: "rotate_actor",
        actorId,
        mode: "relative",
        degrees: 360,
      }).state.actor.rotationY,
    ).toBe(45);
  });
  it("invalid final operation rolls back the whole batch and keeps source identity", () => {
    const state = initialScene();
    const next = transition(state, {
      type: "batch",
      commands: [
        { type: "select_actor", actorId, presetId: "ren" },
        { type: "rotate_actor", actorId, mode: "relative", degrees: 45 },
        { type: "set_outfit", actorId, outfit: "Dragon" },
      ],
    });
    expect(next.state).toBe(state);
    expect(next.result).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_OUTFIT",
    });
  });
  it("valid batch commits one revision and supports capability checks after replacement", () => {
    const next = transition(initialScene(), {
      type: "batch",
      commands: [
        { type: "select_actor", actorId, presetId: "ren" },
        { type: "set_outfit", actorId, outfit: "Suit" },
      ],
    });
    expect(next.state.revision).toBe(1);
    expect(next.state.actor).toMatchObject({ presetId: "ren", outfit: "Suit" });
  });
  it("rejects empty, oversized and nested batches", () => {
    const cmd = { type: "orbit", degrees: 1 };
    for (const commands of [
      [],
      Array(17).fill(cmd),
      [{ type: "batch", commands: [cmd] }],
    ])
      expect(
        transition(initialScene(), { type: "batch", commands }).result.ok,
      ).toBe(false);
  });
  it("rejects an outdated revision", () => {
    const state = initialScene();
    expect(
      transition(state, { type: "orbit", degrees: 1 }, catalog, 9),
    ).toMatchObject({ state, result: { ok: false, code: "STALE_REVISION" } });
  });
});
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("SceneStore loading and animation isolation", () => {
  it("commits replacement only once loaded, preserving camera edits made while waiting", async () => {
    const pending = deferred();
    const controller = createSceneController((asset) =>
      asset.id === "ren" ? pending.promise : Promise.resolve(),
    );
    await controller.initialize();
    const swap = controller.dispatch({
      type: "select_actor",
      actorId,
      presetId: "ren",
    });
    expect(controller.store.getState().scene.actor.presetId).toBe("mira");
    await controller.dispatch({ type: "set_camera", camera: { distance: 3 } });
    pending.resolve();
    expect((await swap).ok).toBe(true);
    expect(controller.store.getState().scene).toMatchObject({
      revision: 2,
      actor: { id: actorId, presetId: "ren" },
      camera: { distance: 3 },
    });
  });
  it("late B cannot override a newer A selection", async () => {
    const pending = deferred();
    const c = createSceneController((asset) =>
      asset.id === "ren" ? pending.promise : Promise.resolve(),
    );
    await c.initialize();
    const old = c.dispatch({ type: "select_actor", actorId, presetId: "ren" });
    await c.dispatch({ type: "select_actor", actorId, presetId: "mira" });
    pending.resolve();
    expect(await old).toMatchObject({ code: "SUPERSEDED" });
    expect(c.store.getState().scene.actor.presetId).toBe("mira");
  });
  it("failed replacement preserves the current scene and can be retried", async () => {
    let fail = true;
    const c = createSceneController(async (asset) => {
      if (asset.id === "ren" && fail) throw new Error("load");
    });
    await c.initialize();
    const before = c.store.getState().scene;
    await c.dispatch({ type: "select_actor", actorId, presetId: "ren" });
    expect(c.store.getState().scene).toBe(before);
    expect(c.store.getState().load.status).toBe("error");
    fail = false;
    await c.retry();
    expect(c.store.getState().scene.actor.presetId).toBe("ren");
    expect(c.store.getState().load.status).toBe("ready");
  });
  it("invalid batch performs no asset loading", async () => {
    const loader = vi.fn(async () => {});
    const c = createSceneController(loader);
    await c.dispatch({
      type: "batch",
      commands: [
        { type: "select_actor", actorId, presetId: "ren" },
        { type: "set_outfit", actorId, outfit: "Dragon" },
      ],
    });
    expect(loader).not.toHaveBeenCalled();
    expect(c.store.getState().scene.revision).toBe(0);
  });
  it("a batch whose asset fails has no partial camera changes", async () => {
    const c = createSceneController(async () => {
      throw new Error("load");
    });
    const before = c.store.getState().scene;
    await c.dispatch({
      type: "batch",
      commands: [
        { type: "set_camera", camera: { distance: 3 } },
        { type: "select_actor", actorId, presetId: "ren" },
      ],
    });
    expect(c.store.getState().scene).toBe(before);
  });
  it("ignores stale wave completion; current wave returns to Idle exactly once", async () => {
    const c = createSceneController(async () => {});
    await c.dispatch({ type: "play_animation", actorId, animation: "Wave" });
    await c.dispatch({ type: "play_animation", actorId, animation: "Wave" });
    c.finishAnimation("mira", 1);
    expect(c.store.getState().scene.actor.animation.name).toBe("Wave");
    c.finishAnimation("mira", 2);
    expect(c.store.getState().scene.actor.animation.name).toBe("Idle");
    const revision = c.store.getState().scene.revision;
    c.finishAnimation("mira", 2);
    expect(c.store.getState().scene.revision).toBe(revision);
  });
  it("cannot commit an asset after controller disposal", async () => {
    const pending = deferred();
    const c = createSceneController(() => pending.promise);
    const request = c.dispatch({
      type: "select_actor",
      actorId,
      presetId: "ren",
    });
    c.dispose();
    pending.resolve();
    expect(await request).toMatchObject({ code: "SUPERSEDED" });
    expect(c.store.getState().scene.revision).toBe(0);
  });
  it("reset cancels an older pending selection", async () => {
    const pending = deferred();
    const c = createSceneController((asset) =>
      asset.id === "ren" ? pending.promise : Promise.resolve(),
    );
    const request = c.dispatch({
      type: "select_actor",
      actorId,
      presetId: "ren",
    });
    await c.dispatch({ type: "reset_scene" });
    pending.resolve();
    await request;
    expect(c.store.getState().scene.actor.presetId).toBe("mira");
    expect(c.store.getState().scene.revision).toBe(1);
  });
});

it.each(["__proto__", "toString"])(
  "capability names %s must be explicitly declared, not inherited",
  (name) => {
    const state = initialScene();
    expect(
      transition(state, {
        type: "select_actor",
        actorId: "actor-1",
        presetId: name,
      }).result,
    ).toMatchObject({ ok: false, code: "UNKNOWN_PRESET" });
    expect(
      transition(state, {
        type: "set_appearance",
        actorId: "actor-1",
        morph: name,
        value: 0.5,
      }).result,
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_MORPH" });
  },
);
