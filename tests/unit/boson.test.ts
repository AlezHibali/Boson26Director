import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BosonClient,
  SpeechSchema,
  AvatarSchema,
  speechPayload,
  ApiError,
} from "../../src/server/boson";
import { POST as speechRoute } from "../../src/app/api/voice-preview/route";
import { POST as avatarRoute } from "../../src/app/api/avatar/route";
import { POST as sessionRoute } from "../../src/app/api/realtime/session/route";
const input = {
  ref_image: "https://docs.boson.ai/public/avatar/sample.jpg",
  input_tts: { text: "I didn't do it.", emotion: "fear" as const },
  size: "640x640" as const,
};
const response = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => Response.json(value, { status, headers });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("schema and payload contracts", () => {
  it("rejects missing image, neither or both driving inputs and unknown fields", () => {
    expect(AvatarSchema.safeParse({ input_tts: { text: "hi" } }).success).toBe(
      false,
    );
    expect(AvatarSchema.safeParse({ ref_image: input.ref_image }).success).toBe(
      false,
    );
    expect(
      AvatarSchema.safeParse({
        ...input,
        input: "https://docs.boson.ai/public/audio/sample.mp3",
      }).success,
    ).toBe(false);
    expect(AvatarSchema.safeParse({ ...input, apiKey: "fake" }).success).toBe(
      false,
    );
  });
  it("limits speech, blocks tag injection and non-allowlisted URLs", () => {
    for (const text of ["", "x".repeat(301), "<|emotion:anger|>hi"])
      expect(SpeechSchema.safeParse({ text }).success).toBe(false);
    expect(
      AvatarSchema.safeParse({
        ...input,
        ref_image: "http://localhost/private",
      }).success,
    ).toBe(false);
    expect(
      AvatarSchema.safeParse({
        ...input,
        ref_image: "data:image/png;base64,aGVsbG8=",
      }).success,
    ).toBe(true);
  });
  it("builds exact emotion tags and deterministic non-streaming TTS", () => {
    expect(speechPayload({ text: "Hello", emotion: "anger" })).toEqual({
      model: "higgs-tts-3",
      voice: "default",
      input: "<|emotion:anger|>Hello",
      response_format: "mp3",
      stream: false,
    });
    expect(speechPayload({ text: "Hello", emotion: "neutral" }).input).toBe(
      "Hello",
    );
  });
});
describe("Boson transport", () => {
  it("requires credentials before any network call", async () => {
    const transport = vi.fn();
    await expect(
      new BosonClient("", 100, transport).session(),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503 });
    expect(transport).not.toHaveBeenCalled();
  });
  it("mints short-lived secrets and sends auth only to fixed host", async () => {
    const transport = vi.fn().mockResolvedValue(
      response({
        value: "bai-eph-test",
        expires_at: 1900000000,
        extra: "not exposed",
      }),
    );
    expect(
      await new BosonClient("test-secret", 1000, transport).session(),
    ).toEqual({ value: "bai-eph-test", expires_at: 1900000000 });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.boson.ai/v1/realtime/client_secrets");
    expect(JSON.parse(init.body)).toEqual({ expires_after: { seconds: 300 } });
    expect(init.headers.Authorization).toBe("Bearer test-secret");
  });
  it.each([
    [401, "UPSTREAM_AUTH", 502],
    [403, "UPSTREAM_AUTH", 502],
    [429, "RATE_LIMITED", 429],
    [500, "UPSTREAM_ERROR", 502],
    [404, "NOT_FOUND", 404],
  ])(
    "maps upstream %i without reflecting response body",
    async (status, code, mapped) => {
      const transport = vi
        .fn()
        .mockResolvedValue(
          response(
            { error: { message: "secret-should-not-leak" } },
            status as number,
            { "retry-after": "3" },
          ),
        );
      try {
        await new BosonClient("fake", 1000, transport).session();
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ code, status: mapped });
        expect(String(error)).not.toContain("secret-should-not-leak");
      }
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("does not retry timed out paid submission and marks outcome unknown", async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new DOMException("Timeout", "TimeoutError"));
    await expect(
      new BosonClient("fake", 1000, transport).createVideo(input),
    ).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("surfaces ordinary connection timeouts separately", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("connection"));
    await expect(
      new BosonClient("fake", 1000, transport).session(),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
  it("rejects malformed successful upstream payloads", async () => {
    const transport = vi.fn().mockResolvedValue(response({ value: "wrong" }));
    await expect(
      new BosonClient("fake", 1000, transport).session(),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("creates Avatar with precisely one driving input", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(response({ id: "video_test", status: "queued" }));
    await new BosonClient("fake", 1000, transport).createVideo(input);
    const payload = JSON.parse(transport.mock.calls[0][1].body);
    expect(payload.input).toBeUndefined();
    expect(payload.input_tts.input).toBe("<|emotion:fear|>I didn't do it.");
  });
  it("does not download queued or failed videos", async () => {
    for (const status of ["queued", "failed"]) {
      const transport = vi
        .fn()
        .mockResolvedValue(
          response({ id: "video_test", status, error: "raw upstream" }),
        );
      await expect(
        new BosonClient("fake", 1000, transport).content("video_test"),
      ).rejects.toMatchObject({ code: "NOT_READY", status: 409 });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it("passes MP4 bytes and Range intact", async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        response({ id: "video_test", status: "completed" }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": "bytes 0-7/8",
          },
        }),
      );
    const result = await new BosonClient("fake", 1000, transport).content(
      "video_test",
      "bytes=0-7",
    );
    expect(result.status).toBe(206);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    expect(transport.mock.calls[1][1].headers.Range).toBe("bytes=0-7");
  });
  it("rejects non-media successful replies", async () => {
    const transport = vi.fn().mockResolvedValue(response({ oops: true }));
    await expect(
      new BosonClient("fake", 1000, transport).speech({
        text: "hi",
        emotion: "neutral",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
describe("API routes with explicitly mocked upstream", () => {
  const req = (value: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  it("rejects invalid inputs without upstream cost", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    expect(
      (
        await avatarRoute(
          req({
            ...input,
            input: "https://docs.boson.ai/public/audio/sample.mp3",
          }),
        )
      ).status,
    ).toBe(400);
    expect((await speechRoute(req({ text: "" }))).status).toBe(400);
    expect((await sessionRoute(req({ unknown: true }))).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects cross-origin paid requests", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    expect(
      (
        await speechRoute(
          req({ text: "hi" }, { origin: "https://other.example" }),
        )
      ).status,
    ).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it("returns safe configuration error", async () => {
    vi.stubEnv("BOSON_API_KEY", "");
    const result = await sessionRoute(req({}));
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      error: { code: "NOT_CONFIGURED" },
    });
  });
  it("streams TTS bytes and prevents caching", async () => {
    vi.stubEnv("BOSON_API_KEY", "fake");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([73, 68, 51]), {
          headers: { "content-type": "audio/mpeg" },
        }),
      ),
    );
    const result = await speechRoute(req({ text: "hello" }));
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([
      73, 68, 51,
    ]);
  });
  it("returns safe 429 plus bounded Retry-After", async () => {
    vi.stubEnv("BOSON_API_KEY", "fake");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ secret: "no" }, 429, { "retry-after": "5" }),
        ),
    );
    const result = await avatarRoute(req(input));
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("5");
    expect(JSON.stringify(await result.json())).not.toContain("secret");
  });
});

describe("ambiguous submissions and invalid download ranges", () => {
  it("marks a malformed accepted Avatar response as unknown rather than safe to repeat", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "queued" }));
    await expect(
      new BosonClient("fake", 1000, transport).createVideo(input),
    ).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["bytes=-", "bytes=0-1,3-4", "items=0-1"])(
    "rejects invalid Range %s before contacting provider",
    async (range) => {
      const { GET } =
        await import("../../src/app/api/avatar/[id]/content/route");
      const transport = vi.fn();
      vi.stubGlobal("fetch", transport);
      const result = await GET(
        new Request("http://localhost/api/avatar/video_test/content", {
          headers: { range },
        }),
        { params: Promise.resolve({ id: "video_test" }) },
      );
      expect(result.status).toBe(400);
      expect(transport).not.toHaveBeenCalled();
    },
  );
});
