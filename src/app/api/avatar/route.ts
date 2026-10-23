import { AvatarSchema } from "@/server/boson";
import { body, failure, json } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return json(await takes().legacy(await body(request, AvatarSchema)), 202);
  } catch (error) {
    return failure(error);
  }
}
