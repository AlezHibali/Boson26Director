import { json } from "@/server/http";
export const dynamic = "force-dynamic";
export function GET() {
  return json({
    stage: 1,
    configured: Boolean(process.env.BOSON_API_KEY?.trim()),
    provider: "Boson",
    models: ["higgs-realtime", "higgs-tts-3", "higgs-avatar"],
    mode: "live",
    paidRequestsAutoRetry: false,
  });
}
