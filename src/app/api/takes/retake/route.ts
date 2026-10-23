import { RetakeSchema } from "@/domain/take";
import { body, failure, json } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    return json(await takes().retake(await body(req, RetakeSchema)), 202);
  } catch (e) {
    return failure(e);
  }
}
