import { z } from "zod";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
    public retryAfter?: string,
  ) {
    super(message);
  }
}
const tags = {
  neutral: "",
  fear: "<|emotion:fear|>",
  anger: "<|emotion:anger|>",
} as const;
export const SpeechSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine(
        (v) => !v.includes("<|"),
        "Please use the emotion selector, not inline tags.",
      ),
    emotion: z.enum(["neutral", "fear", "anger"]).default("neutral"),
  })
  .strict();
const media = (kind: "image" | "audio") =>
  z
    .string()
    .max(3000000)
    .refine((value) => {
      const official =
        kind === "image"
          ? "https://docs.boson.ai/public/avatar/sample.jpg"
          : "https://docs.boson.ai/public/audio/sample.mp3";
      const pattern =
        kind === "image"
          ? /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
          : /^data:audio\/(mpeg|wav);base64,[A-Za-z0-9+/]+={0,2}$/;
      return value === official || pattern.test(value);
    }, "Use the official sample or an inline local capture (max ~2 MB).");
export const AvatarSchema = z
  .object({
    ref_image: media("image"),
    input: media("audio").optional(),
    input_tts: SpeechSchema.optional(),
    size: z.enum(["640x640", "640x480", "480x640"]).default("640x640"),
  })
  .strict()
  .refine(
    (v) =>
      Number(v.input !== undefined) + Number(v.input_tts !== undefined) === 1,
    "Exactly one of input or input_tts is required.",
  );
export const VideoIdSchema = z.string().regex(/^video_[a-zA-Z0-9_-]{1,120}$/);
const VideoSchema = z.object({
  id: VideoIdSchema,
  status: z.enum(["queued", "in_progress", "completed", "failed"]),
  progress: z.number().optional(),
  error: z.string().nullable().optional(),
});
export type VideoJob = z.infer<typeof VideoSchema>;
export function speechPayload(value: z.infer<typeof SpeechSchema>) {
  return {
    model: "higgs-tts-3",
    voice: "default",
    input: tags[value.emotion] + value.text,
    response_format: "mp3",
    stream: false,
  };
}
export function avatarPayload(value: z.infer<typeof AvatarSchema>) {
  return {
    model: "higgs-avatar",
    ref_image: value.ref_image,
    size: value.size,
    ...(value.input
      ? { input: value.input }
      : { input_tts: speechPayload(value.input_tts!) }),
  };
}
export class BosonClient {
  constructor(
    private apiKey: string,
    private timeoutMs = 30000,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    init: RequestInit = {},
    expected = "application/json",
  ) {
    if (!this.apiKey.trim())
      throw new ApiError(
        "NOT_CONFIGURED",
        "请在 .env.local 配置 BOSON_API_KEY，并重启服务。",
        503,
      );
    let response: Response;
    try {
      response = await this.transport("https://api.boson.ai/v1" + path, {
        ...init,
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: "Bearer " + this.apiKey,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      const unknown = init.method === "POST" && path === "/videos";
      throw new ApiError(
        unknown ? "SUBMISSION_UNKNOWN" : "UPSTREAM_UNAVAILABLE",
        unknown
          ? "提交结果未知。上游可能已接收，请勿自动重试或重复生成。"
          : "Boson 连接失败或超时，请稍后手动重试。",
        504,
      );
    }
    if (!response.ok) {
      const status = response.status;
      // Never reflect upstream bodies: they can contain credentials or submitted media.
      await response.body?.cancel();
      if (status === 401 || status === 403)
        throw new ApiError(
          "UPSTREAM_AUTH",
          "Boson 凭证无效或当前模型无权限。",
          502,
        );
      if (status === 429)
        throw new ApiError(
          "RATE_LIMITED",
          "Boson 调用限流，请稍后手动重试。",
          429,
          response.headers.get("retry-after") || undefined,
        );
      if (status === 404)
        throw new ApiError(
          "NOT_FOUND",
          "视频或内容尚不存在，可能未完成或已过期。",
          404,
        );
      throw new ApiError(
        "UPSTREAM_ERROR",
        status >= 500
          ? "Boson 服务暂不可用。"
          : "Boson 拒绝了请求，请检查输入或账户权限。",
        502,
      );
    }
    if (!response.headers.get("content-type")?.includes(expected)) {
      await response.body?.cancel();
      throw new ApiError("INVALID_RESPONSE", "Boson 返回了不符合协议的响应。");
    }
    return response;
  }
  private async json(path: string, init?: RequestInit): Promise<unknown> {
    try {
      return await (await this.request(path, init)).json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("INVALID_RESPONSE", "Boson 响应无效或传输中断。");
    }
  }
  async session(ttl = 300) {
    const data = await this.json("/realtime/client_secrets", {
      method: "POST",
      body: JSON.stringify({ expires_after: { seconds: ttl } }),
    });
    const parsed = z
      .object({
        value: z.string().startsWith("bai-eph-"),
        expires_at: z.number().int().positive(),
      })
      .safeParse(data);
    if (!parsed.success)
      throw new ApiError("INVALID_RESPONSE", "临时凭证响应格式无效。");
    return parsed.data;
  }
  async speech(value: z.infer<typeof SpeechSchema>) {
    return this.request(
      "/audio/speech",
      { method: "POST", body: JSON.stringify(speechPayload(value)) },
      "audio/",
    );
  }
  async createVideo(value: z.infer<typeof AvatarSchema>) {
    try {
      return this.parseVideo(
        await this.json("/videos", {
          method: "POST",
          body: JSON.stringify(avatarPayload(value)),
        }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_RESPONSE") {
        throw new ApiError(
          "SUBMISSION_UNKNOWN",
          "上游可能已接收，但未返回有效任务 ID。请勿重复提交。",
          502,
        );
      }
      throw error;
    }
  }
  async video(id: string) {
    return this.parseVideo(
      await this.json("/videos/" + VideoIdSchema.parse(id)),
    );
  }
  private parseVideo(data: unknown): VideoJob {
    const parsed = VideoSchema.safeParse(data);
    if (!parsed.success)
      throw new ApiError("INVALID_RESPONSE", "视频任务响应格式无效。");
    return {
      ...parsed.data,
      error:
        parsed.data.status === "failed"
          ? "Boson 视频生成失败，请调整人像或检查账户后重新创建。"
          : null,
    };
  }
  async content(id: string, range?: string) {
    const job = await this.video(id);
    if (job.status !== "completed")
      throw new ApiError(
        "NOT_READY",
        job.status === "failed"
          ? "生成失败，无可下载视频。"
          : "视频尚未生成完成。",
        409,
      );
    return this.request(
      "/videos/" + id + "/content",
      { headers: range ? { Range: range } : {} },
      "video/mp4",
    );
  }
}
