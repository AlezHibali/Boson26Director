import { metricsSnapshot } from "@/server/metrics";
import { json } from "@/server/http";
export const runtime = "nodejs";
export async function GET() {
  return json(metricsSnapshot());
}
