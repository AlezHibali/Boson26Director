import { AvatarSchema } from "@/server/boson";
import { body, client, failure, json } from "@/server/http";
export async function POST(request: Request) {
  try {
    return json(
      await client().createVideo(await body(request, AvatarSchema)),
      202,
    );
  } catch (error) {
    return failure(error);
  }
}
