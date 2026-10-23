import { TakeIdSchema } from "@/domain/take";
import { failure, json } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    return json(
      await takes().refresh(TakeIdSchema.parse((await ctx.params).id)),
    );
  } catch (e) {
    return failure(e);
  }
}
