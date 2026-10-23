import { CreateTakeSchema } from "@/domain/take";
import { body, failure, json } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function GET() {
  try {
    return json({ takes: takes().list() });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(req: Request) {
  try {
    return json(await takes().create(await body(req, CreateTakeSchema)), 202);
  } catch (e) {
    return failure(e);
  }
}
