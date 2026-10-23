import { z } from "zod";
import { TakeIdSchema } from "@/domain/take";
import { body, json, failure } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await body(req, z.object({}).strict());
    return json(
      await takes().archive(TakeIdSchema.parse((await ctx.params).id)),
    );
  } catch (e) {
    return failure(e);
  }
}
