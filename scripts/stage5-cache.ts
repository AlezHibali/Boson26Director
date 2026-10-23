import { readFile, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { takes } from "../src/server/takes";
const checkpoint = JSON.parse(
  await readFile("docs/evidence/private/stage4/checkpoint.json", "utf8"),
);
const service = takes();
for (const [id, label] of [
  [checkpoint.baseId, "fear"],
  [checkpoint.retakeId, "anger"],
]) {
  const t = service.get(id);
  if (t.input.emotion !== label || t.status !== "completed")
    throw Error("Checkpoint does not match an existing completed Take.");
  const file = "docs/evidence/private/stage4/" + label + ".mp4";
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  );
  if (
    !probe.streams.some(
      (s: any) =>
        s.codec_type === "video" && s.width === 640 && s.height === 640,
    )
  )
    throw Error("Recovery media dimensions invalid.");
  const handle = await open(file, "r");
  try {
    await service.importArchive(
      id,
      handle.readableWebStream() as unknown as ReadableStream<Uint8Array>,
      "recovered-stage4",
    );
  } finally {
    await handle.close().catch(() => {});
  }
  console.log(
    "Recovered original " +
      label +
      " Take into local media archive; no Avatar submission.",
  );
}
service.db.close();
