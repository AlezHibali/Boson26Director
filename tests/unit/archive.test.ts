import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { storeArchive, archivedContent } from "../../src/server/archive";
const mp4 = () => {
  const b = Buffer.alloc(128);
  b.write("ftyp", 4);
  for (let i = 32; i < 128; i++) b[i] = i;
  return b;
};
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
async function run(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "director-archive-"));
  try {
    await fn(dir);
  } finally {
    const p = resolve(dir);
    if (
      !p.startsWith(resolve(tmpdir()) + sep) ||
      !p.includes("director-archive-")
    )
      throw Error("Unsafe cleanup");
    rmSync(p, { recursive: true, force: true });
  }
}
describe("Stage 5 local media archive", () => {
  it("stores an atomic MP4, records hash and supports full, closed, open and suffix ranges", async () =>
    run(async (dir) => {
      const id = randomUUID(),
        data = mp4(),
        info = await storeArchive(dir, id, stream(data), "provider");
      expect(info.bytes).toBe(128);
      expect(info.hash).toHaveLength(64);
      const full = await archivedContent(dir, id, info);
      expect(full.status).toBe(200);
      expect(Buffer.from(await full.arrayBuffer())).toEqual(data);
      for (const [range, start, end] of [
        ["bytes=32-63", 32, 64],
        ["bytes=100-", 100, 128],
        ["bytes=-16", 112, 128],
      ] as const) {
        const r = await archivedContent(dir, id, info, range);
        expect(r.status).toBe(206);
        expect(Buffer.from(await r.arrayBuffer())).toEqual(
          data.subarray(start, end),
        );
      }
      const bad = await archivedContent(dir, id, info, "bytes=999-");
      expect(bad.status).toBe(416);
      expect(bad.headers.get("content-range")).toBe("bytes */128");
    }));
  it("rejects non-MP4 and oversized media without leaving partial files", async () =>
    run(async (dir) => {
      await expect(
        storeArchive(
          dir,
          randomUUID(),
          stream(Buffer.from("bad media")),
          "provider",
        ),
      ).rejects.toMatchObject({ code: "INVALID_MEDIA" });
      await expect(
        storeArchive(
          dir,
          randomUUID(),
          stream(new Uint8Array(50 * 1024 * 1024 + 1)),
          "provider",
        ),
      ).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
      expect(readdirSync(dir)).toHaveLength(0);
    }));
  it("keeps the previous good archive if a subsequent copy fails", async () =>
    run(async (dir) => {
      const id = randomUUID(),
        data = mp4(),
        info = await storeArchive(dir, id, stream(data), "provider");
      await expect(
        storeArchive(dir, id, stream(Buffer.from("bad media")), "provider"),
      ).rejects.toThrow();
      const r = await archivedContent(dir, id, info);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(data);
    }));
  it("reports missing local files rather than silently generating replacement content", async () =>
    run(async (dir) => {
      await expect(
        archivedContent(dir, randomUUID(), {
          bytes: 128,
          hash: "hash",
          storedAt: new Date().toISOString(),
          source: "provider",
        }),
      ).rejects.toMatchObject({ code: "ARCHIVE_MISSING" });
    }));
  it("rejects unsafe file identifiers", async () =>
    run(async (dir) => {
      await expect(
        storeArchive(dir, "../escape", stream(mp4()), "provider"),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }));
});

it("Take archive survives SQLite reopen and plays locally when the provider expires", async () =>
  run(async (dir) => {
    const { TakeService } = await import("../../src/server/takes");
    const { initialScene } = await import("../../src/domain/scene");
    const { vi } = await import("vitest");
    const bytes = mp4(),
      provider = {
        createVideo: vi
          .fn()
          .mockResolvedValue({ id: "video_test", status: "queued" }),
        video: vi
          .fn()
          .mockResolvedValue({ id: "video_test", status: "completed" }),
        content: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              new Response(bytes, { headers: { "Content-Type": "video/mp4" } }),
            ),
          ),
      };
    const db = join(dir, "takes.sqlite"),
      service = new TakeService(db, provider);
    const png = Buffer.alloc(32);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(640, 20);
    const t = await service.create({
      requestId: "archive",
      scene: initialScene(),
      portrait: "data:image/png;base64," + png.toString("base64"),
    });
    await service.refresh(t.id);
    const saved = await service.archive(t.id);
    expect(saved.archive?.bytes).toBe(128);
    expect(saved.inputHash).toBe(t.inputHash);
    service.db.close();
    const next = new TakeService(db, provider);
    try {
      provider.content.mockRejectedValue(new Error("Expired"));
      const r = await next.content(t.id, "bytes=32-63");
      expect(r.status).toBe(206);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(
        bytes.subarray(32, 64),
      );
      expect(provider.content).toHaveBeenCalledTimes(1);
      expect(provider.createVideo).toHaveBeenCalledTimes(1);
    } finally {
      next.db.close();
    }
  }));
