import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  createTakeController,
  retryDelay,
} from "../../src/studio/take-controller";
import { initialScene, transition } from "../../src/domain/scene";
import { commandsToRestore } from "../../src/studio/restore";
import { ToolBridge } from "../../src/voice/tool-bridge";
import { performanceTools } from "../../src/voice/tools";
const base = () =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    requestId: "saved",
    baseTakeId: null,
    status: "completed",
    videoId: "video_1",
    createdAt: new Date().toISOString(),
    progress: 100,
    error: null,
    input: {
      scene: initialScene(),
      emotion: "fear",
      reference: {
        hash: "hash",
        version: "portrait-v1",
        appearanceKey: "key",
        mode: "captured",
      },
      model: "higgs-avatar",
      ttsModel: "higgs-tts-3",
      voice: "default",
      size: "640x640",
    },
    inputHash: "hash",
    invariantHash: "same",
  }) as any;
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  const scene = initialScene(),
    stop = vi.fn();
  const transport = vi.fn().mockResolvedValue(Response.json({ takes: [] }));
  const capture = vi.fn().mockResolvedValue("portrait");
  const c = createTakeController({
    scene: () => scene,
    capture,
    transport,
    stopPlayback: stop,
  });
  return { scene, stop, transport, capture, c };
}
describe("Take client and restore", () => {
  it("freezes before awaiting the portrait and rejects rapid double clicks", async () => {
    const f = fixture();
    await f.c.refresh();
    let captured!: (v: string) => void;
    f.capture.mockImplementation(() => new Promise((r) => (captured = r)));
    f.transport.mockResolvedValue(
      Response.json({ ...base(), status: "queued" }),
    );
    const first = f.c.action("one");
    const second = await f.c.action("two");
    expect(second.ok).toBe(false);
    f.scene.camera.distance = 3;
    captured("image");
    await first;
    const sent = JSON.parse(f.transport.mock.calls[1][1].body);
    expect(sent.scene.camera.distance).toBe(5.2);
    expect(f.capture.mock.calls[0][0].camera.distance).toBe(5.2);
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("updates each Take by ID without stealing selection and never changes the stage", async () => {
    const f = fixture();
    await f.c.refresh();
    const a = base(),
      b = {
        ...base(),
        id: "00000000-0000-4000-8000-000000000002",
        status: "queued",
      };
    f.c.upsert(a);
    f.c.upsert(b);
    f.c.select(a.id);
    f.c.upsert({ ...b, status: "completed" });
    expect(f.c.store.getState().selectedId).toBe(a.id);
    expect(f.c.store.getState().takes).toHaveLength(2);
    expect(f.scene).toEqual(initialScene());
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("retake requires a selected source and submits only base ID plus emotion", async () => {
    const f = fixture();
    await f.c.refresh();
    expect((await f.c.retake("anger", "one")).ok).toBe(false);
    const a = base();
    f.c.upsert(a);
    f.c.select(a.id);
    f.scene.camera.distance = 3;
    f.transport.mockResolvedValue(
      Response.json({
        ...base(),
        id: "00000000-0000-4000-8000-000000000002",
        status: "queued",
      }),
    );
    expect((await f.c.retake("anger", "two")).ok).toBe(true);
    expect(JSON.parse(f.transport.mock.calls[1][1].body)).toEqual({
      requestId: "two",
      baseTakeId: a.id,
      overrides: { emotion: "anger" },
    });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it("Cut stops video and assistant; disconnect before capture finishes prevents paid POST", async () => {
    const f = fixture();
    await f.c.refresh();
    const reply = vi.fn();
    f.c.bindReplyStop(reply);
    f.c.stopPlayback();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    const abort = new AbortController();
    let finish!: (v: string) => void;
    f.capture.mockImplementation(() => new Promise((r) => (finish = r)));
    const p = f.c.action("cancelled", abort.signal);
    abort.abort();
    finish("image");
    expect((await p).ok).toBe(false);
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it("submission response loss queries history and keeps unknown state; it never retries POST", async () => {
    const f = fixture();
    await f.c.refresh();
    f.transport
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(Response.json({ takes: [] }));
    expect((await f.c.action("uncertain")).ok).toBe(false);
    expect(f.c.store.getState().uncertain).toBe(true);
    expect(localStorage.getItem("director-pending-request")).toBe("uncertain");
    expect((await f.c.action("new")).ok).toBe(false);
    expect(
      f.transport.mock.calls.filter((c) => c[1]?.method === "POST"),
    ).toHaveLength(1);
  });
  it("recovered pending request clears browser uncertainty after refresh", async () => {
    localStorage.setItem("director-pending-request", "saved");
    const f = fixture();
    f.transport.mockResolvedValue(Response.json({ takes: [base()] }));
    const cleanup = f.c.start();
    await vi.waitFor(() => expect(f.c.store.getState().loaded).toBe(true));
    expect(f.c.store.getState().uncertain).toBe(false);
    expect(localStorage.getItem("director-pending-request")).toBeNull();
    cleanup();
  });
  it("polling backs off, slows hidden pages, pauses after ten minutes without falsely failing and resumes GET only", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: true });
    const f = fixture(),
      t = { ...base(), status: "queued" };
    f.transport.mockImplementation((url: string) =>
      Promise.resolve(Response.json(url === "/api/takes" ? { takes: [t] } : t)),
    );
    const cleanup = f.c.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14999);
    expect(f.transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.transport).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(610000);
    expect(f.c.store.getState().paused).toBe(true);
    expect(f.c.store.getState().takes[0].status).toBe("queued");
    f.c.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.c.store.getState().paused).toBe(false);
    expect(f.transport.mock.calls.every((c) => !c[1]?.method)).toBe(true);
    cleanup();
  });
  it("parses numeric and HTTP-date Retry-After", () => {
    expect(retryDelay("9")).toBe(9000);
    expect(retryDelay(new Date(20000).toUTCString(), 10000)).toBe(10000);
    expect(retryDelay("garbage")).toBe(0);
  });
  it("restores a full saved set atomically with fresh revision and animation token", () => {
    const saved = initialScene();
    saved.actor.presetId = "ren";
    saved.actor.outfit = "Suit";
    saved.actor.appearance.EyeSize = 0.8;
    saved.camera.distance = 3;
    const current = initialScene();
    current.revision = 50;
    current.actor.animation.token = 23;
    const next = transition(current, commandsToRestore(saved, "anger"));
    expect(next.result.ok).toBe(true);
    expect(next.state.revision).toBe(51);
    expect(next.state.camera).toEqual(saved.camera);
    expect(next.state.actor.presetId).toBe("ren");
    expect(next.state.performance.emotion).toBe("anger");
    expect(current.camera.distance).toBe(5.2);
  });
});
describe("Stage 4 paid voice tools", () => {
  const done = (id: string, calls: any[]) => ({
    type: "response.done",
    response: { id, status: "completed", output: calls },
  });
  const call = (id: string, name: string, args = {}) => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
  function bridge() {
    const sent: any[] = [],
      effect = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          revision: 0,
          message: "submitted",
          notices: [],
          takeId: "take-id",
          status: "queued",
        });
    const execute = vi.fn(),
      abort = new AbortController();
    const b = new ToolBridge({
      getScene: initialScene,
      execute,
      effect,
      log: () => {},
    });
    const scope = {
      active: () => true,
      signal: abort.signal,
      send: (v: any) => sent.push(v),
      continueResponse: () => {},
    };
    return { b, scope, effect, execute, sent, abort };
  }
  it("advertises the three implemented effects with strict schemas", () => {
    expect(performanceTools.map((t) => t.name)).toEqual([
      "perform",
      "retake",
      "stop_playback",
    ]);
    expect(
      performanceTools.every(
        (t) => t.parameters.additionalProperties === false,
      ),
    ).toBe(true);
  });
  it("same call_id invokes paid effect once and returns its original takeId on replay", async () => {
    const f = bridge();
    await f.b.handleDone(done("r1", [call("action-1", "perform")]), f.scope);
    await f.b.handleDone(done("r2", [call("action-1", "perform")]), f.scope);
    expect(f.effect).toHaveBeenCalledOnce();
    expect(f.sent.map((e) => JSON.parse(e.item.output).takeId)).toEqual([
      "take-id",
      "take-id",
    ]);
  });
  it("rejects mixed staging/paid effects and invalid retake arguments before any side effect", async () => {
    const f = bridge();
    await f.b.handleDone(
      done("mixed", [
        call("a", "perform"),
        call("b", "orbit", { degrees: 15 }),
      ]),
      f.scope,
    );
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(JSON.parse(f.sent[0].item.output).code).toBe("MIXED_EFFECTS");
    await f.b.handleDone(
      done("invalid", [call("c", "retake", { emotion: "rage" })]),
      f.scope,
    );
    expect(f.effect).not.toHaveBeenCalled();
  });
  it("an already disconnected scope cannot submit or stop playback", async () => {
    const f = bridge();
    f.abort.abort();
    await f.b.handleDone(done("old", [call("a", "perform")]), f.scope);
    expect(f.effect).not.toHaveBeenCalled();
  });
});

it("local HTTP 5xx remains uncertain and only an explicit review can release a missing-record lock", async () => {
  const scene = initialScene();
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ takes: [] }))
    .mockResolvedValueOnce(
      Response.json({ error: { message: "gateway timeout" } }, { status: 502 }),
    )
    .mockResolvedValue(Response.json({ takes: [] }));
  const c = createTakeController({
    scene: () => scene,
    capture: async () => "image",
    transport,
    stopPlayback: () => {},
  });
  await c.refresh();
  await c.action("missing-record");
  expect(c.store.getState().uncertain).toBe(true);
  expect((await c.action("new")).ok).toBe(false);
  c.resolveLocalUncertainty();
  expect(c.store.getState().uncertain).toBe(false);
  expect(localStorage.getItem("director-pending-request")).toBeNull();
  expect(
    transport.mock.calls.filter((c) => c[1]?.method === "POST"),
  ).toHaveLength(1);
});

it("a recovered submitting record without a video ID keeps polling until the server saves the ID", async () => {
  vi.useFakeTimers();
  const t = { ...base(), status: "submitting", videoId: null };
  const transport = vi
    .fn()
    .mockImplementation((url: string) =>
      Promise.resolve(
        Response.json(
          url === "/api/takes"
            ? { takes: [t] }
            : { ...t, status: "queued", videoId: "video_1" },
        ),
      ),
    );
  const c = createTakeController({
    scene: initialScene,
    capture: async () => "image",
    transport,
    stopPlayback: () => {},
  });
  const cleanup = c.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(transport.mock.calls.map((c) => c[0])).toEqual([
    "/api/takes",
    "/api/takes/" + t.id,
  ]);
  expect(c.store.getState().takes[0].videoId).toBe("video_1");
  cleanup();
});
