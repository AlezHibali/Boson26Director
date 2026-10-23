import { SpeechSchema } from "@/server/boson";
import { body, client, failure, mediaResponse } from "@/server/http";
export async function POST(request: Request) {
  try {
    return mediaResponse(
      await client().speech(await body(request, SpeechSchema)),
    );
  } catch (error) {
    return failure(error);
  }
}
