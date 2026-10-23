import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { demoScene } from "../../src/domain/demo";
import { initialScene, transition } from "../../src/domain/scene";
import { commandsToRestore } from "../../src/studio/restore";
import { BosonClient } from "../../src/server/boson";
import {
  metricsSnapshot,
  recordMetric,
  operationFor,
} from "../../src/server/metrics";
import { preflight } from "../../scripts/lib/preflight";
afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as any).directorMetrics;
});
describe("Stage 5 release controls", () => {
  it("demo preset is reproducible and does not mutate initial state or inputs", () => {
    const a = demoScene(),
      b = demoScene();
    a.actor.outfit = "Casual";
    expect(b.actor.outfit).toBe("Suit");
    const state = initialScene();
    for (let i = 0; i < 3; i++) {
      const t = transition(state, commandsToRestore(b));
      expect(t.result.ok).toBe(true);
      expect(t.state.actor.appearance.EyeSize).toBe(0.55);
    }
    expect(state).toEqual(initialScene());
  });
  it("metrics only retain a bounded numeric DTO, never URLs, authorization or payload extras", () => {
    for (let i = 0; i < 140; i++)
      recordMetric({
        operation: "tts_headers",
        durationMs: i,
        outcome: "ok",
        authorization: "SENSITIVE_SENTINEL",
        input: "private",
      } as any);
    const report = metricsSnapshot();
    expect(report.samples).toHaveLength(128);
    expect(
      report.summary.find((s) => s.operation === "tts_headers")?.count,
    ).toBe(128);
    expect(JSON.stringify(report)).not.toContain("SENSITIVE_SENTINEL");
    expect(JSON.stringify(report)).not.toContain("private");
    recordMetric({ operation: "tts_headers", durationMs: NaN, outcome: "ok" });
    expect(metricsSnapshot().samples).toHaveLength(128);
  });
  it("maps ID paths to fixed operation names without retaining IDs", () => {
    expect(operationFor("/videos/video_example/content")).toBe(
      "avatar_content_headers",
    );
    expect(operationFor("/videos/video_example")).toBe("avatar_poll");
    expect(operationFor("/unknown")).toBeUndefined();
  });
  it("observes success and failure transport latency without credentials or response bodies", async () => {
    const seen: any[] = [];
    const client = new BosonClient(
      "SENSITIVE_SENTINEL",
      1000,
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([73, 68, 51]), {
            headers: { "Content-Type": "audio/mpeg" },
          }),
        ),
      (v) => seen.push(v),
    );
    await client.speech({ text: "Private dialogue", emotion: "fear" });
    const bad = new BosonClient(
      "SENSITIVE_SENTINEL",
      1000,
      vi.fn().mockRejectedValue(new Error("private body")),
      (v) => seen.push(v),
    );
    await expect(
      bad.speech({ text: "Private dialogue", emotion: "fear" }),
    ).rejects.toThrow();
    expect(seen.map((v) => v.outcome)).toEqual(["ok", "error"]);
    expect(
      seen.every((v) => v.operation === "tts_headers" && v.durationMs >= 0),
    ).toBe(true);
    expect(JSON.stringify(seen)).not.toContain("SENSITIVE_SENTINEL");
    expect(JSON.stringify(seen)).not.toContain("Private dialogue");
  });
  it("a broken observer cannot turn an accepted paid submission into an error", async () => {
    const c = new BosonClient(
      "fake",
      1000,
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "video_test", status: "queued" }),
        ),
      () => {
        throw Error("observer down");
      },
    );
    expect(
      (
        await c.createVideo({
          ref_image: "https://docs.boson.ai/public/avatar/sample.jpg",
          input_tts: { text: "Hi", emotion: "fear" },
          size: "640x640",
        })
      ).id,
    ).toBe("video_test");
  });
  it("preflight works without a key and reports only presence of a configured key", async () => {
    const root = mkdtempSync(join(tmpdir(), "director-preflight-"));
    try {
      mkdirSync(join(root, "public/actors"), { recursive: true });
      for (const file of [
        "package-lock.json",
        "public/actors/mira.glb",
        "public/actors/ren.glb",
        "public/actors/LICENSE.txt",
      ])
        writeFileSync(join(root, file), "fixture");
      vi.stubEnv("BOSON_API_KEY", undefined);
      vi.stubEnv("NEXT_PUBLIC_BOSON_API_KEY", "");
      const missing = await preflight(root);
      expect(missing.ok).toBe(true);
      expect(missing.providerConfigured).toBe(false);
      writeFileSync(
        join(root, ".env.local"),
        "BOSON_API_KEY=SENSITIVE_SENTINEL",
      );
      const configured = await preflight(root);
      expect(configured.providerConfigured).toBe(true);
      expect(JSON.stringify(configured)).not.toContain("SENSITIVE_SENTINEL");
      writeFileSync(
        join(root, ".env.local"),
        "NEXT_PUBLIC_BOSON_API_KEY=SENSITIVE_SENTINEL",
      );
      expect((await preflight(root)).ok).toBe(false);
    } finally {
      const target = resolve(root),
        base = resolve(tmpdir()) + sep;
      if (!target.startsWith(base) || !target.includes("director-preflight-"))
        throw Error("Unsafe cleanup path");
      rmSync(target, { recursive: true, force: true });
    }
  });
});
