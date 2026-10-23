import { z } from "zod";
import { TakeIdSchema } from "@/domain/take";
import { VideoIdSchema } from "@/server/boson";
import { body, failure, json } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const v = await body(
      req,
      z.union([
        z.object({ videoId: VideoIdSchema }).strict(),
        z.object({ confirmedNotAccepted: z.literal(true) }).strict(),
      ]),
    );
    const id = TakeIdSchema.parse((await ctx.params).id);
    return json(
      "videoId" in v
        ? await takes().reconcile(id, v.videoId)
        : takes().resolveNotAccepted(id),
    );
  } catch (e) {
    return failure(e);
  }
}
