import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { TakeService } from "../../src/server/takes";
import { ApiError } from "../../src/server/boson";
import { initialScene } from "../../src/domain/scene";
import { CreateTakeSchema } from "../../src/domain/take";
import { POST, GET } from "../../src/app/api/takes/route";
import { POST as retakeRoute } from "../../src/app/api/takes/retake/route";
import { GET as takeRoute } from "../../src/app/api/takes/[id]/route";
import { GET as contentRoute } from "../../src/app/api/takes/[id]/content/route";
import { POST as reconcileRoute } from "../../src/app/api/takes/[id]/reconcile/route";
const png = Buffer.alloc(64);
Buffer.from("89504e470d0a1a0a", "hex").copy(png);
png.writeUInt32BE(640, 16);
png.writeUInt32BE(640, 20);
const portrait = "data:image/png;base64," + png.toString("base64");
const payload = (id = "request-1") => ({
  requestId: id,
  scene: initialScene(),
  portrait,
});
const services: TakeService[] = [];
function fixture(file = ":memory:") {
  const provider = {
    createVideo: vi.fn().mockResolvedValue({ id: "video_1", status: "queued" }),
    video: vi
      .fn()
      .mockResolvedValue({ id: "video_1", status: "completed", progress: 100 }),
    content: vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
        headers: { "content-type": "video/mp4", "accept-ranges": "bytes" },
      }),
    ),
  };
  const service = new TakeService(file, provider);
  services.push(service);
  return { service, provider };
}
afterEach(() => {
  for (const s of services.splice(0)) {
    try {
      s.db.close();
    } catch {}
  }
  vi.useRealTimers();
  delete (globalThis as any).directorTakes;
});
const req = (data: unknown, origin = "http://localhost") =>
  new Request("http://localhost/api/takes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(data),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
describe("A15–A19: durable paid jobs", () => {
  it("persists frozen inputs before the single upstream call; duplicate inflight submission returns the same Take", async () => {
    const { service, provider } = fixture();
    let resolve!: (v: any) => void;
    provider.createVideo.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const input = payload();
    const first = service.create(input);
    expect(service.list()[0].status).toBe("submitting");
    const duplicate = await service.create(input);
    expect(duplicate.id).toBe(service.list()[0].id);
    expect(provider.createVideo).toHaveBeenCalledTimes(1);
    input.scene.camera.distance = 3;
    expect(service.get(duplicate.id).input.scene.camera.distance).toBe(5.2);
    resolve({ id: "video_1", status: "queued" });
    expect((await first).id).toBe(duplicate.id);
    expect(await service.create(payload())).toMatchObject({
      id: duplicate.id,
      videoId: "video_1",
    });
  });
  it("rejects ID conflicts and concurrent new IDs without charging", async () => {
    const { service, provider } = fixture();
    await service.create(payload());
    const changed = payload();
    changed.scene.performance.emotion = "anger";
    await expect(service.create(changed)).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    await expect(service.create(payload("request-2"))).rejects.toMatchObject({
      code: "TAKE_BUSY",
    });
    expect(provider.createVideo).toHaveBeenCalledTimes(1);
  });
  it("retake changes only effective emotion; all other fields and the source remain identical", async () => {
    const { service, provider } = fixture();
    const base = await service.create(payload());
    await service.refresh(base.id);
    provider.createVideo.mockResolvedValue({ id: "video_2", status: "queued" });
    const next = await service.retake({
      requestId: "retake",
      baseTakeId: base.id,
      overrides: { emotion: "anger" },
    });
    expect(next.baseTakeId).toBe(base.id);
    expect(next.invariantHash).toBe(base.invariantHash);
    expect(next.inputHash).not.toBe(base.inputHash);
    expect(next.input).toEqual({ ...base.input, emotion: "anger" });
    expect(service.get(base.id).input).toEqual(base.input);
    expect(provider.createVideo.mock.calls[1][0]).toMatchObject({
      ref_image: portrait,
      input_tts: { text: "I didn't do it.", emotion: "anger" },
    });
    await expect(
      service.retake({
        requestId: "bad",
        baseTakeId: base.id,
        overrides: { emotion: "anger", camera: { distance: 3 } },
      }),
    ).rejects.toThrow();
  });
  it("persists video IDs across a real SQLite reopen and updates by takeId", async () => {
    mkdirSync(".data", { recursive: true });
    const file = ".data/test-" + randomUUID() + ".sqlite";
    try {
      const f = fixture(file);
      const a = await f.service.create(payload());
      await f.service.refresh(a.id);
      f.provider.createVideo.mockResolvedValue({
        id: "video_2",
        status: "queued",
      });
      const b = await f.service.create(payload("second"));
      f.service.db.close();
      const second = fixture(file);
      expect(second.service.list()).toHaveLength(2);
      expect(second.service.get(a.id).videoId).toBe("video_1");
      second.provider.video.mockResolvedValue({
        id: "video_2",
        status: "completed",
        progress: 100,
      });
      await second.service.refresh(b.id);
      expect(second.service.get(b.id).status).toBe("completed");
      expect(second.service.get(a.id).inputHash).toBe(a.inputHash);
      expect(second.provider.createVideo).not.toHaveBeenCalled();
      second.service.db.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"])
        try {
          unlinkSync(file + suffix);
        } catch {}
    }
  });
  it("a process restart turns abandoned submitting into unknown without resubmission", async () => {
    mkdirSync(".data", { recursive: true });
    const file = ".data/test-" + randomUUID() + ".sqlite";
    try {
      const f = fixture(file);
      f.provider.createVideo.mockImplementation(() => new Promise(() => {}));
      void f.service.create(payload());
      f.service.db.close();
      const next = fixture(file);
      expect(next.service.list()[0].status).toBe("submission_unknown");
      await expect(next.service.create(payload("new"))).rejects.toMatchObject({
        code: "TAKE_BUSY",
      });
      expect(next.provider.createVideo).not.toHaveBeenCalled();
      next.service.db.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"])
        try {
          unlinkSync(file + suffix);
        } catch {}
    }
  });
  it.each(["SUBMISSION_UNKNOWN", "UPSTREAM_ERROR", "INVALID_RESPONSE"])(
    "ambiguous %s retains the active slot until a confirmed video ID is attached",
    async (code) => {
      const { service, provider } = fixture();
      provider.createVideo.mockRejectedValue(new ApiError(code, "safe"));
      const t = await service.create(payload());
      expect(t.status).toBe("submission_unknown");
      await expect(service.create(payload("new"))).rejects.toMatchObject({
        code: "TAKE_BUSY",
      });
      const recovered = await service.reconcile(t.id, "video_1");
      expect(recovered.status).toBe("completed");
      expect(provider.createVideo).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "RATE_LIMITED",
    "UPSTREAM_AUTH",
    "UPSTREAM_REJECTED",
    "NOT_CONFIGURED",
  ])(
    "definite %s is saved as failed and allows an explicit new action",
    async (code) => {
      const { service, provider } = fixture();
      provider.createVideo.mockRejectedValue(new ApiError(code, "safe"));
      expect((await service.create(payload())).status).toBe("failed");
      provider.createVideo.mockResolvedValue({
        id: "video_2",
        status: "queued",
      });
      expect((await service.create(payload("new"))).status).toBe("queued");
      expect(provider.createVideo).toHaveBeenCalledTimes(2);
    },
  );
  it("poll failure, 429 backoff and an expired download never create a new video or falsely fail the task", async () => {
    vi.useFakeTimers();
    const { service, provider } = fixture();
    const t = await service.create(payload());
    provider.video.mockRejectedValueOnce(
      new ApiError("RATE_LIMITED", "slow", 429, "9"),
    );
    await expect(service.refresh(t.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect((await service.refresh(t.id)).status).toBe("queued");
    expect(provider.video).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    await service.refresh(t.id);
    provider.content.mockRejectedValue(
      new ApiError("NOT_FOUND", "expired", 404),
    );
    await expect(service.content(t.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(service.get(t.id).status).toBe("completed");
    expect(provider.createVideo).toHaveBeenCalledTimes(1);
  });
  it("rejects unbounded, malformed and unsupported snapshot inputs before any paid call", async () => {
    const { service, provider } = fixture();
    for (const mutate of [
      (v: any) => (v.scene.actor.presetId = "unknown"),
      (v: any) => (v.scene.camera.distance = 0),
      (v: any) => (v.scene.performance.dialogue = "<|emotion:anger|>Hi"),
      (v: any) => (v.extra = true),
      (v: any) => (v.scene.actor.expression = { Unknown: 1 }),
    ]) {
      const v = payload();
      mutate(v);
      expect(CreateTakeSchema.safeParse(v).success).toBe(false);
      await expect(service.create(v)).rejects.toThrow();
    }
    await expect(
      service.create({
        ...payload(),
        portrait: "data:image/png;base64,aGVsbG8=",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PORTRAIT" });
    expect(provider.createVideo).not.toHaveBeenCalled();
  });
});
describe("same-origin Take HTTP routes", () => {
  it("covers create → query → retake → MP4 Range proxy, history and pre-completion denial", async () => {
    const { service, provider } = fixture();
    (globalThis as any).directorTakes = service;
    const created = await POST(req(payload()));
    expect(created.status).toBe(202);
    const t = await created.json();
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(
      (await contentRoute(new Request("http://localhost"), ctx(t.id))).status,
    ).toBe(409);
    expect((await GET()).status).toBe(200);
    expect(
      (
        await (
          await takeRoute(new Request("http://localhost"), ctx(t.id))
        ).json()
      ).status,
    ).toBe("completed");
    const r = await contentRoute(
      new Request("http://localhost", { headers: { Range: "bytes=0-7" } }),
      ctx(t.id),
    );
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(provider.content).toHaveBeenCalledWith("video_1", "bytes=0-7");
    expect(new Uint8Array(await r.arrayBuffer())).toHaveLength(8);
    provider.createVideo.mockResolvedValue({ id: "video_2", status: "queued" });
    expect(
      (
        await retakeRoute(
          req({
            requestId: "next",
            baseTakeId: t.id,
            overrides: { emotion: "anger" },
          }),
        )
      ).status,
    ).toBe(202);
    expect(
      (await POST(req(payload("other"), "https://evil.invalid"))).status,
    ).toBe(403);
    expect(provider.createVideo).toHaveBeenCalledTimes(2);
  });
  it("returns 409 conflicts and bounds unknown reconciliation to recorded Takes", async () => {
    const { service, provider } = fixture();
    (globalThis as any).directorTakes = service;
    provider.createVideo.mockRejectedValue(
      new ApiError("SUBMISSION_UNKNOWN", "unknown"),
    );
    const t = await (await POST(req(payload()))).json();
    expect((await POST(req(payload("next")))).status).toBe(409);
    expect(
      (await reconcileRoute(req({ videoId: "video_1" }), ctx(t.id))).status,
    ).toBe(200);
    expect(
      (await contentRoute(new Request("http://localhost"), ctx(randomUUID())))
        .status,
    ).toBe(404);
    expect(
      (await reconcileRoute(req({ videoId: "../escape" }), ctx(t.id))).status,
    ).toBe(400);
    expect(provider.createVideo).toHaveBeenCalledTimes(1);
  });
});

it("Lab shares the single paid task slot and queries release its completed diagnostic slot", async () => {
  const { service, provider } = fixture();
  const job = await service.legacy({
    ref_image: "https://docs.boson.ai/public/avatar/sample.jpg",
    input_tts: { text: "Hi", emotion: "neutral" },
    size: "640x640",
  });
  expect(service.list()[0].input.reference.mode).toBe("diagnostic");
  await expect(service.create(payload())).rejects.toMatchObject({
    code: "TAKE_BUSY",
  });
  await service.video(job.id);
  await expect(
    service.retake({
      requestId: "retake-lab",
      baseTakeId: service.list()[0].id,
      overrides: { emotion: "anger" },
    }),
  ).rejects.toMatchObject({ code: "DIAGNOSTIC_TAKE" });
  provider.createVideo.mockResolvedValue({ id: "video_2", status: "queued" });
  expect((await service.create(payload())).status).toBe("queued");
  expect(provider.createVideo).toHaveBeenCalledTimes(2);
});
it("operator verification releases an unknown slot without pretending to cancel or making a provider call", async () => {
  const { service, provider } = fixture();
  provider.createVideo.mockRejectedValue(
    new ApiError("SUBMISSION_UNKNOWN", "unknown"),
  );
  const t = await service.create(payload());
  expect(service.resolveNotAccepted(t.id)).toMatchObject({
    status: "failed",
    videoId: null,
  });
  expect(service.get(t.id).error).toContain("未取消任何云端任务");
  expect(provider.createVideo).toHaveBeenCalledTimes(1);
  expect(provider.video).not.toHaveBeenCalled();
});
it("invalid Range and cross-origin recovery never reach provider content or mutate the unknown job", async () => {
  const { service, provider } = fixture();
  (globalThis as any).directorTakes = service;
  provider.createVideo.mockRejectedValue(
    new ApiError("SUBMISSION_UNKNOWN", "unknown"),
  );
  const t = await service.create(payload());
  expect(
    (
      await reconcileRoute(
        req({ confirmedNotAccepted: true }, "https://evil.invalid"),
        ctx(t.id),
      )
    ).status,
  ).toBe(403);
  expect(service.get(t.id).status).toBe("submission_unknown");
  expect(
    (
      await contentRoute(
        new Request("http://localhost", {
          headers: { Range: "bytes=0-1,3-4" },
        }),
        ctx(t.id),
      )
    ).status,
  ).toBe(400);
  expect(provider.content).not.toHaveBeenCalled();
  expect(
    (await reconcileRoute(req({ confirmedNotAccepted: true }), ctx(t.id)))
      .status,
  ).toBe(200);
});

it("completedAt and avatar total latency are captured once, never fabricated for historic records", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T20:00:00Z"));
  const { service, provider } = fixture();
  const t = await service.create(payload());
  expect(t.completedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000);
  const completed = await service.refresh(t.id);
  expect(completed.completedAt).toBe("2026-10-23T20:00:02.000Z");
  expect((await service.refresh(t.id)).completedAt).toBe(completed.completedAt);
  expect(provider.video).toHaveBeenCalledOnce();
});
