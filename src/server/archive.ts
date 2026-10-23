import { createReadStream } from "node:fs";
import { mkdir, open, rename, unlink, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { ApiError } from "./boson";
const mediaPath = (dir: string, id: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new ApiError("INVALID_INPUT", "无效的 Take ID。", 400);
  return path.join(dir, id + ".mp4");
};
export type ArchiveInfo = {
  hash: string;
  bytes: number;
  storedAt: string;
  source: "provider" | "recovered-stage4";
};
export async function storeArchive(
  dir: string,
  id: string,
  stream: ReadableStream<Uint8Array>,
  source: ArchiveInfo["source"],
): Promise<ArchiveInfo> {
  await mkdir(dir, { recursive: true });
  const target = mediaPath(dir, id),
    temp = target + "." + randomUUID() + ".part";
  const file = await open(temp, "wx"),
    reader = stream.getReader(),
    hash = createHash("sha256");
  let bytes = 0,
    header = Buffer.alloc(0);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 50 * 1024 * 1024)
        throw new ApiError("ARCHIVE_TOO_LARGE", "本地归档上限为 50 MB。", 413);
      if (header.length < 32)
        header = Buffer.concat([
          header,
          Buffer.from(next.value.subarray(0, 32 - header.length)),
        ]);
      hash.update(next.value);
      let offset = 0;
      while (offset < next.value.byteLength) {
        const r = await file.write(
          next.value,
          offset,
          next.value.byteLength - offset,
        );
        offset += r.bytesWritten;
      }
    }
    if (bytes < 32 || header.subarray(4, 8).toString() !== "ftyp")
      throw new ApiError(
        "INVALID_MEDIA",
        "收到的文件不是可识别的 MP4；未保存归档。",
        502,
      );
    await file.sync();
    await file.close();
    await rename(temp, target);
    return {
      hash: hash.digest("hex"),
      bytes,
      storedAt: new Date().toISOString(),
      source,
    };
  } catch (e) {
    await reader.cancel().catch(() => {});
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}
export async function archivedContent(
  dir: string,
  id: string,
  info: ArchiveInfo,
  range?: string,
) {
  const file = mediaPath(dir, id);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new ApiError(
      "ARCHIVE_MISSING",
      "本地视频归档缺失；可重新归档仍可用的供应商资源。",
      410,
    );
  }
  if (size !== info.bytes)
    throw new ApiError(
      "ARCHIVE_DAMAGED",
      "本地归档大小不匹配；请恢复备份或重新归档。",
      410,
    );
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(size),
  };
  let start = 0,
    end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: {
          ...headers,
          "Content-Length": "0",
          "Content-Range": "bytes */" + size,
        },
      });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size ||
      (!match[1] && Number(match[2]) === 0)
    )
      return new Response(null, {
        status: 416,
        headers: {
          ...headers,
          "Content-Length": "0",
          "Content-Range": "bytes */" + size,
        },
      });
    headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
    headers["Content-Length"] = String(end - start + 1);
  }
  return new Response(
    Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream,
    { status: range ? 206 : 200, headers },
  );
}
