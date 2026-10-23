import { VideoIdSchema } from "@/server/boson";
import { failure, json } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return json(
      await takes().video(VideoIdSchema.parse((await context.params).id)),
    );
  } catch (error) {
    return failure(error);
  }
}
