import { TakeIdSchema } from "@/domain/take";
import { failure, noStore } from "@/server/http";
import { takes } from "@/server/takes";
export const runtime = "nodejs";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const data = takes().portrait(TakeIdSchema.parse((await ctx.params).id));
    if (data === "https://docs.boson.ai/public/avatar/sample.jpg")
      return new Response(null, {
        status: 307,
        headers: { ...noStore, Location: data },
      });
    return new Response(Buffer.from(data.split(",")[1], "base64"), {
      headers: { ...noStore, "Content-Type": data.slice(5, data.indexOf(";")) },
    });
  } catch (e) {
    return failure(e);
  }
}
