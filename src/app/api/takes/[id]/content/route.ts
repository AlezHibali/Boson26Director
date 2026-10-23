import { ApiError } from "@/server/boson";
import { TakeIdSchema } from "@/domain/take";
import { failure, mediaResponse } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const range = req.headers.get("range") || undefined;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      throw new ApiError("INVALID_INPUT", "不支持的 Range 请求。", 400);
    return mediaResponse(
      await takes().content(TakeIdSchema.parse((await ctx.params).id), range),
    );
  } catch (e) {
    return failure(e);
  }
}
