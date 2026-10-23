import { z } from "zod";
import { recordMetric } from "./metrics";
import { ApiError, BosonClient } from "./boson";
export function client() {
  const configured = Number(process.env.BOSON_TIMEOUT_MS || 30000);
  return new BosonClient(
    process.env.BOSON_API_KEY || "",
    Number.isFinite(configured)
      ? Math.max(1000, Math.min(configured, 120000))
      : 30000,
    fetch,
    recordMetric,
  );
}
export const noStore = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: noStore });
}
export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const origin = request.headers.get("origin");
  if (
    origin &&
    origin !==
      new URL(request.url).protocol +
        "//" +
        (request.headers.get("host") || new URL(request.url).host)
  )
    throw new ApiError("ORIGIN_REJECTED", "只接受同源请求。", 403);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ApiError("INVALID_INPUT", "请求需使用 application/json。", 400);
  if (Number(request.headers.get("content-length") || 0) > 3100000)
    throw new ApiError("PAYLOAD_TOO_LARGE", "输入超过诊断页大小限制。", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("INVALID_INPUT", "请求内容为空。", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > 3100000) {
      await reader.cancel();
      throw new ApiError("PAYLOAD_TOO_LARGE", "输入超过诊断页大小限制。", 413);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new ApiError(
      "INVALID_INPUT",
      "输入无效：请检查台词、人像以及 input/input_tts 二选一要求。",
      400,
    );
  }
}
export function failure(error: unknown) {
  const known =
    error instanceof ApiError
      ? error
      : error instanceof z.ZodError
        ? new ApiError("INVALID_INPUT", "输入或视频 ID 无效。", 400)
        : new ApiError("INTERNAL_ERROR", "请求处理失败。", 500);
  return Response.json(
    { error: { code: known.code, message: known.message } },
    {
      status: known.status,
      headers: {
        ...noStore,
        ...(known.retryAfter &&
        (/^\d{1,5}$/.test(known.retryAfter) ||
          Number.isFinite(Date.parse(known.retryAfter)))
          ? { "Retry-After": known.retryAfter }
          : {}),
      },
    },
  );
}
export function mediaResponse(upstream: Response) {
  const headers = new Headers(noStore);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
