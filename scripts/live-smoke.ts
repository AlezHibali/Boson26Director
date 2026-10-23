import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { BosonClient, ApiError } from "../src/server/boson";
try {
  process.loadEnvFile(".env.local");
} catch {}
const dir = "docs/evidence/private";
await mkdir(dir, { recursive: true });
const client = new BosonClient(process.env.BOSON_API_KEY || "", 120000);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  mode: "REAL BOSON API",
  limitations: [
    "Realtime audio output is exercised with a text turn; a human microphone conversation still needs manual acceptance.",
  ],
};
const reportPath = dir + "/live-report.json";
async function persist() {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
async function realtime(secret: string, valid: boolean) {
  return new Promise<{
    closeCode?: number;
    audioBytes: number;
    events: string[];
  }>((resolve, reject) => {
    const ws = new WebSocket("wss://api.boson.ai/v1/realtime", [
      "realtime",
      "bai-client-secret." + secret,
    ]);
    const events = new Set<string>();
    const audio: Buffer[] = [];
    let done = false;
    const finish = (error?: Error, closeCode?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else {
        if (audio.length)
          void writeFile(dir + "/realtime-reply.pcm", Buffer.concat(audio));
        resolve({
          closeCode,
          audioBytes: audio.reduce((n, b) => n + b.length, 0),
          events: [...events],
        });
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Realtime response timed out.")),
      45000,
    );
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            model: "higgs-realtime",
            output_modalities: ["audio"],
            instructions: "Reply with exactly one brief greeting.",
            audio: {
              input: { turn_detection: null },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: "default",
              },
            },
          },
        }),
      ),
    );
    ws.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      events.add(value.type);
      if (
        value.type === "session.created" ||
        value.type === "session.updated"
      ) {
        ws.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Hello. Please greet me." },
              ],
            },
          }),
        );
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (
        ["response.output_audio.delta", "response.audio.delta"].includes(
          value.type,
        )
      )
        audio.push(Buffer.from(value.delta, "base64"));
      if (value.type === "error" && valid)
        finish(new Error("Realtime reported a protocol/model error."));
      if (value.type === "response.done" && valid)
        finish(
          audio.length ? undefined : new Error("Realtime produced no audio."),
        );
    });
    ws.on("close", (code) => {
      if (!valid)
        finish(
          code === 3000
            ? undefined
            : new Error(
                "Unexpected invalid/expired credential close code: " + code,
              ),
          code,
        );
      else if (!done)
        finish(new Error("Realtime closed before audio response: " + code));
    });
    ws.on("error", () =>
      finish(new Error("Realtime WebSocket failed to connect.")),
    );
  });
}
try {
  const token = await client.session();
  report.realtime = await realtime(token.value, true);
  await persist();
  console.log("PASS Realtime: session configured and PCM reply received.");
  report.invalidSecret = await realtime(
    "bai-eph-deliberately-invalid-diagnostic",
    false,
  );
  await persist();
  console.log("PASS Realtime: invalid temporary credential rejected.");
  const expiring = await client.session(10);
  await new Promise((r) => setTimeout(r, 11000));
  report.expiredSecret = await realtime(expiring.value, false);
  await persist();
  console.log("PASS Realtime: expired temporary credential rejected.");
  for (const emotion of ["fear", "anger"] as const) {
    const path = dir + "/" + emotion + ".mp3";
    const started = Date.now();
    if (!existsSync(path)) {
      const response = await client.speech({
        text: "I didn't do it.",
        emotion,
      });
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
    }
    report["tts_" + emotion] = {
      bytes: (await readFile(path)).byteLength,
      elapsedMs: Date.now() - started,
      path,
    };
    await persist();
    console.log(
      "PASS TTS " +
        emotion +
        ": audio bytes saved (decode checked separately).",
    );
  }
  const statePath = dir + "/avatar-checkpoint.json";
  const checkpoint: Record<
    string,
    { id?: string; status: string; inputHash: string }
  > = existsSync(statePath)
    ? JSON.parse(await readFile(statePath, "utf8"))
    : {};
  for (const reference of ["official", "actor"]) {
    const file = "docs/evidence/actor-portrait.png";
    if (reference === "actor" && !existsSync(file))
      throw new Error(
        "Capture the actor portrait in browser tests before live Avatar validation.",
      );
    const image =
      reference === "official"
        ? "https://docs.boson.ai/public/avatar/sample.jpg"
        : "data:image/png;base64," + readFileSync(file).toString("base64");
    const inputHash = createHash("sha256").update(image).digest("hex");
    const started = Date.now();
    if (!checkpoint[reference]) {
      checkpoint[reference] = { status: "submitting", inputHash };
      await writeFile(statePath, JSON.stringify(checkpoint, null, 2));
      const job = await client.createVideo({
        ref_image: image,
        input_tts: { text: "I didn't do it.", emotion: "fear" },
        size: "640x640",
      });
      checkpoint[reference] = { id: job.id, status: job.status, inputHash };
      await writeFile(statePath, JSON.stringify(checkpoint, null, 2));
    }
    const existing = checkpoint[reference];
    if (!existing.id)
      throw new Error(
        "Previous " +
          reference +
          " submission outcome is unknown. Inspect before explicitly clearing the checkpoint; no automatic paid retry.",
      );
    if (existing.inputHash !== inputHash)
      throw new Error(
        "Reference changed since checkpoint. Do not silently replace an existing job.",
      );
    let job = await client.video(existing.id);
    for (
      let poll = 0;
      !["completed", "failed"].includes(job.status) && poll < 120;
      poll++
    ) {
      await new Promise((r) => setTimeout(r, 5000));
      job = await client.video(existing.id);
      if (poll % 6 === 0)
        console.log("Avatar " + reference + ": " + job.status);
    }
    checkpoint[reference].status = job.status;
    await writeFile(statePath, JSON.stringify(checkpoint, null, 2));
    if (job.status !== "completed")
      throw new Error(
        "Avatar " +
          reference +
          " ended or remains in state " +
          job.status +
          ". Resume lookup without resubmission.",
      );
    const path = dir + "/avatar-" + reference + ".mp4";
    if (!existsSync(path)) {
      const response = await client.content(existing.id);
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
    }
    report["avatar_" + reference] = {
      id: existing.id,
      status: job.status,
      elapsedMs: Date.now() - started,
      bytes: (await readFile(path)).length,
      inputHash,
      path,
    };
    await persist();
    console.log(
      "PASS Avatar " + reference + ": completed and MP4 bytes saved.",
    );
  }
  report.result = "PASS_PROTOCOL";
  await persist();
  console.log("Live smoke complete. Private report saved without API keys.");
} catch (error) {
  report.result = "FAILED_OR_BLOCKED";
  report.error =
    error instanceof ApiError
      ? { code: error.code, message: error.message }
      : error instanceof Error
        ? error.message
        : "Unknown error";
  await persist();
  console.error(
    "Live smoke blocked:",
    error instanceof ApiError
      ? error.code
      : error instanceof Error
        ? error.message
        : "Unknown error",
  );
  process.exitCode = 1;
}
