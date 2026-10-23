import { describe, it, expect, vi, afterEach } from "vitest";
import { VoiceSession, type SocketLike } from "../../src/voice/session";
import { createSceneController } from "../../src/studio/controller";
class Socket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send = (data: string) => {
    const event = JSON.parse(data);
    this.sent.push(event);
    if (event.type === "session.update")
      this.emit({
        type: event.session.model ? "session.created" : "session.updated",
      });
  };
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  close() {
    this.readyState = 3;
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  break(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  const controller = createSceneController(async () => {});
  const sockets: Socket[] = [];
  const minted: string[] = [];
  let pcm: (data: ArrayBuffer) => void = () => {};
  let ended = () => {};
  let drained = () => {};
  let online = true;
  const audio = {
    play: vi.fn(),
    interrupt: vi.fn(() => ({
      truncations: [
        { item_id: "audio-1", content_index: 0, audio_end_ms: 100 },
      ],
      latencyMs: 0.2,
    })),
    close: vi.fn(),
    isPlaying: vi.fn(() => false),
  };
  const openAudio = vi.fn(
    async (
      cb: (v: ArrayBuffer) => void,
      onEnded: () => void,
      _signal: AbortSignal,
      onDrained: () => void,
    ) => {
      pcm = cb;
      ended = onEnded;
      drained = onDrained;
      return audio;
    },
  );
  const session = new VoiceSession({
    getScene: () => controller.store.getState().scene,
    execute: (command, signal) =>
      controller.dispatch(command, undefined, signal),
    subscribe: (fn) => controller.store.subscribe(fn),
    mint: async () => {
      const token = "bai-eph-" + (minted.length + 1);
      minted.push(token);
      return { value: token, expires_at: Date.now() / 1000 + 300 };
    },
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    audio: openAudio,
    online: () => online,
  });
  return {
    session,
    controller,
    sockets,
    minted,
    audio,
    openAudio,
    pcm: (data: ArrayBuffer) => pcm(data),
    end: () => ended(),
    drain: () => drained(),
    offline: () => {
      online = false;
      session.networkChanged();
    },
    online: () => {
      online = true;
      session.networkChanged();
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("A12 / B10-B12 voice connection and playback lifecycle", () => {
  it("starts once on repeated clicks, waits for ack, sends real PCM format and cleans up", async () => {
    const f = fixture();
    await Promise.all([f.session.start(), f.session.start()]);
    await settle();
    expect(f.openAudio).toHaveBeenCalledTimes(1);
    expect(f.minted).toHaveLength(1);
    expect(f.session.getSnapshot().connected).toBe(true);
    expect(f.sockets[0].sent[0]).toMatchObject({
      type: "session.update",
      session: {
        model: "higgs-realtime",
        output_modalities: ["audio"],
        audio: { input: { format: { type: "audio/pcm", rate: 24000 } } },
      },
    });
    f.pcm(new ArrayBuffer(4800));
    expect(f.sockets[0].sent.at(-1)?.type).toBe("input_audio_buffer.append");
    f.session.stop();
    expect(f.audio.close).toHaveBeenCalledTimes(1);
    expect(f.session.getSnapshot().active).toBe(false);
  });
  it("barge-in stops playback, truncates at actually heard progress and ignores late cancelled audio", async () => {
    const f = fixture();
    await f.session.start();
    await settle();
    const ws = f.sockets[0];
    ws.emit({ type: "response.created", response: { id: "r1" } });
    ws.emit({
      type: "response.output_audio.delta",
      response_id: "r1",
      item_id: "audio-1",
      delta: "AAAA",
    });
    ws.emit({ type: "input_audio_buffer.speech_started" });
    ws.emit({
      type: "response.output_audio.delta",
      response_id: "r1",
      item_id: "audio-1",
      delta: "AAAA",
    });
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.audio.interrupt).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContainEqual({
      type: "conversation.item.truncate",
      item_id: "audio-1",
      content_index: 0,
      audio_end_ms: 100,
    });
    expect(f.session.getSnapshot().interruptionMs).toBe(0.2);
    f.session.stop();
  });
  it("reconnects with a new secret and ignores late old handlers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    await settle();
    const old = f.sockets[0];
    const late = old.onmessage!;
    old.break(3000);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(f.minted).toEqual(["bai-eph-1", "bai-eph-2"]);
    late({
      data: JSON.stringify({
        type: "response.done",
        response: {
          id: "old",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "old-call",
              name: "orbit",
              arguments: '{"degrees":15}',
            },
          ],
        },
      }),
    });
    await settle();
    expect(f.controller.store.getState().scene.revision).toBe(0);
    expect(f.session.getSnapshot().connections).toBe(2);
    f.session.stop();
  });
  it("manual edits refresh model context and new tools operate on the latest state", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    await settle();
    await f.controller.dispatch({
      type: "set_camera",
      camera: { distance: 3 },
    });
    await vi.advanceTimersByTimeAsync(120);
    const updates = f.sockets[0].sent.filter(
      (event) => event.type === "session.update",
    );
    expect(updates.at(-1)?.session.instructions).toContain('"distance":3');
    f.sockets[0].emit({
      type: "response.done",
      response: {
        id: "r1",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "c",
            name: "dolly",
            arguments: '{"amount":0.4}',
          },
        ],
      },
    });
    await settle();
    expect(f.controller.store.getState().scene.camera.distance).toBe(2.6);
    f.session.stop();
  });
  it("offline does not repeatedly mint keys, online restores fresh scene context", async () => {
    const f = fixture();
    await f.session.start();
    await settle();
    f.offline();
    expect(f.minted).toHaveLength(1);
    await f.controller.dispatch({
      type: "set_outfit",
      actorId: "actor-1",
      outfit: "Suit",
    });
    f.online();
    await settle();
    expect(f.minted).toHaveLength(2);
    expect(f.sockets[1].sent[0].session.instructions).toContain(
      '"outfit":"Suit"',
    );
    f.session.stop();
  });
  it("bounds automatic retries and releases mic after repeated connection loss", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    await settle();
    f.sockets[0].break();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    f.sockets[1].break();
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    f.sockets[2].break();
    expect(f.minted).toHaveLength(3);
    expect(f.audio.close).toHaveBeenCalledTimes(1);
    expect(f.session.getSnapshot().phase).toBe("error");
  });
  it("mic unplug stops the session without automatically opening another device", async () => {
    const f = fixture();
    await f.session.start();
    await settle();
    f.end();
    expect(f.session.getSnapshot().phase).toBe("error");
    expect(f.openAudio).toHaveBeenCalledTimes(1);
    expect(f.audio.close).toHaveBeenCalledTimes(1);
  });
  it("permission denial leaves an actionable stopped session", async () => {
    const f = fixture();
    f.openAudio.mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    await f.session.start();
    expect(f.session.getSnapshot()).toMatchObject({
      active: false,
      phase: "error",
    });
    expect(f.session.getSnapshot().status).toContain("权限被拒绝");
    expect(f.minted).toHaveLength(0);
  });
  it("stop during pending mic permission releases late-acquired resources", async () => {
    const f = fixture();
    let grant!: (v: typeof f.audio) => void;
    f.openAudio.mockImplementationOnce(
      () => new Promise((yes) => (grant = yes)),
    );
    const starting = f.session.start();
    f.session.stop();
    grant(f.audio);
    await starting;
    expect(f.audio.close).toHaveBeenCalledTimes(1);
    expect(f.minted).toHaveLength(0);
  });
});

it("late old response.done cannot trigger a continuation that interrupts a newer response", async () => {
  const f = fixture();
  await f.session.start();
  await settle();
  const ws = f.sockets[0];
  ws.emit({ type: "response.created", response: { id: "old" } });
  ws.emit({ type: "response.created", response: { id: "new" } });
  ws.emit({
    type: "response.done",
    response: {
      id: "old",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "old-tool",
          name: "orbit",
          arguments: '{"degrees":15}',
        },
      ],
    },
  });
  await settle();
  expect(ws.sent.filter((e) => e.type === "response.create")).toHaveLength(0);
  ws.emit({
    type: "response.done",
    response: { id: "new", status: "completed", output: [] },
  });
  await settle();
  expect(ws.sent.filter((e) => e.type === "response.create")).toHaveLength(1);
  expect(f.controller.store.getState().scene.camera.azimuth).toBe(15);
  f.session.stop();
});

it("response generation completion does not announce listening until local playback drains", async () => {
  const f = fixture();
  await f.session.start();
  await settle();
  const ws = f.sockets[0];
  f.audio.isPlaying.mockReturnValue(true);
  ws.emit({ type: "response.created", response: { id: "r" } });
  ws.emit({
    type: "response.output_audio.delta",
    response_id: "r",
    item_id: "a",
    delta: "AAAA",
  });
  ws.emit({
    type: "response.done",
    response: { id: "r", status: "completed", output: [] },
  });
  await settle();
  expect(f.session.getSnapshot().phase).toBe("speaking");
  f.audio.isPlaying.mockReturnValue(false);
  f.drain();
  expect(f.session.getSnapshot().phase).toBe("listening");
  f.session.stop();
});
