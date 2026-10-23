import { ApiError, VideoIdSchema } from "@/server/boson";
import { client, failure, mediaResponse } from "@/server/http";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const id = VideoIdSchema.parse((await context.params).id);
    const range = request.headers.get("range") || undefined;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      throw new ApiError("INVALID_INPUT", "不支持的 Range 请求。", 400);
    return mediaResponse(await client().content(id, range));
  } catch (error) {
    return failure(error);
  }
}
