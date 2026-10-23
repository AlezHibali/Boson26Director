import { VideoIdSchema } from "@/server/boson";
import { client, failure, json } from "@/server/http";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return json(
      await client().video(VideoIdSchema.parse((await context.params).id)),
    );
  } catch (error) {
    return failure(error);
  }
}
