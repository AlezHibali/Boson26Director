import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { BosonClient } from "../src/server/boson";
import { VoiceSession, type SocketLike } from "../src/voice/session";
import { createSceneController } from "../src/studio/controller";
import type { SceneState } from "../src/domain/scene";
try {
  process.loadEnvFile(".env.local");
} catch {}
const dir = "docs/evidence/private/stage3";
await mkdir(dir, { recursive: true });
const client = new BosonClient(process.env.BOSON_API_KEY || "", 120000);
const corpus: {
  id: string;
  text: string;
  check: (s: SceneState) => boolean;
}[] = [
  {
    id: "01-actor-en",
    text: "Replace the actor with Ren. Keep everything else unchanged.",
    check: (s) => s.actor.presetId === "ren",
  },
  {
    id: "02-outfit-zh",
    text: "把演员的衣服换成黑色西装。",
    check: (s) => s.actor.outfit === "Suit",
  },
  {
    id: "03-turn-wave-en",
    text: "Turn the actor right forty-five degrees and wave.",
    check: (s) => s.actor.rotationY === 45 && s.actor.animation.name === "Wave",
  },
  {
    id: "04-dolly-zh",
    text: "镜头靠近一点。",
    check: (s) => s.camera.distance === 4.8,
  },
  {
    id: "05-orbit-en",
    text: "Orbit the camera fifteen degrees to the right.",
    check: (s) => s.camera.azimuth === 15,
  },
  {
    id: "06-eyes-zh",
    text: "把演员的眼睛大小设置为零点八。",
    check: (s) => s.actor.appearance.EyeSize === 0.8,
  },
  {
    id: "07-face-en",
    text: "Set the actor's face width to zero point six.",
    check: (s) => s.actor.appearance.FaceWidth === 0.6,
  },
  {
    id: "08-lights-zh",
    text: "主光亮度设为二，补光亮度设为零点五，其他不变。",
    check: (s) => s.lights.key === 2 && s.lights.fill === 0.5,
  },
  {
    id: "09-script-en",
    text: "Set the actor's line to: We need to talk. Set the emotion to anger.",
    check: (s) =>
      s.performance.dialogue
        .toLowerCase()
        .replace(/[.，。!]/g, "")
        .trim() === "we need to talk" && s.performance.emotion === "anger",
  },
  {
    id: "10-compound-zh",
    text: "保持其他内容不变，换成Ren，穿黑色西装，向右转四十五度。",
    check: (s) =>
      s.actor.presetId === "ren" &&
      s.actor.outfit === "Suit" &&
      s.actor.rotationY === 45 &&
      s.camera.distance === 5.2 &&
      s.lights.key === 3.5,
  },
];
const controller = createSceneController(async () => {});
let pcm: ((buffer: ArrayBuffer) => void) | undefined;
let outputBytes = 0;
function socket(secret: string): SocketLike {
  const ws = new WebSocket("wss://api.boson.ai/v1/realtime", [
    "realtime",
    "bai-client-secret." + secret,
  ]);
  const adapter: SocketLike = {
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on("open", () => adapter.onopen?.({}));
  ws.on("message", (data) => adapter.onmessage?.({ data: data.toString() }));
  ws.on("close", (code) => adapter.onclose?.({ code }));
  ws.on("error", () => adapter.onerror?.({}));
  return adapter;
}
const session = new VoiceSession({
  getScene: () => controller.store.getState().scene,
  execute: (command, signal) => controller.dispatch(command, undefined, signal),
  subscribe: (fn) => controller.store.subscribe(fn),
  mint: () => client.session(),
  socket,
  online: () => true,
  audio: async (callback) => {
    pcm = callback;
    return {
      play: (data) => {
        outputBytes += Buffer.from(data, "base64").length;
      },
      interrupt: () => ({ truncations: [], latencyMs: 0 }),
      close: () => {
        pcm = undefined;
      },
    };
  },
});
async function wait(check: () => boolean, timeout = 40000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Wait timed out.");
    if (session.getSnapshot().phase === "error")
      throw new Error("Voice session entered error state.");
    await new Promise((r) => setTimeout(r, 80));
  }
}
const report: {
  date: string;
  mode: string;
  cases: unknown[];
  result?: string;
  passed?: number;
  total?: number;
  outputBytes?: number;
  error?: string;
} = {
  date: new Date().toISOString(),
  mode: "REAL TTS -> PCM -> REAL Higgs Realtime -> shared VoiceSession/ToolBridge -> real domain controller",
  cases: [],
};
const persist = () =>
  writeFile(dir + "/corpus-report.json", JSON.stringify(report, null, 2));
try {
  for (const item of corpus) {
    const mp3 = dir + "/" + item.id + ".mp3";
    if (!existsSync(mp3)) {
      const response = await client.speech({
        text: item.text,
        emotion: "neutral",
      });
      await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
    }
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      mp3,
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-y",
      dir + "/" + item.id + ".pcm",
    ]);
  }
  await session.start();
  await wait(() => session.getSnapshot().connected);
  let passed = 0;
  for (const item of corpus) {
    await controller.dispatch({ type: "reset_scene" });
    await new Promise((r) => setTimeout(r, 250));
    const known = new Set(session.getSnapshot().tools.map((t) => t.callId));
    const start = Date.now();
    const bytes = await readFile(dir + "/" + item.id + ".pcm");
    const audio = Buffer.concat([bytes, Buffer.alloc(48000)]);
    for (let offset = 0; offset < audio.length; offset += 4800) {
      const piece = audio.subarray(offset, offset + 4800);
      pcm?.(
        piece.buffer.slice(
          piece.byteOffset,
          piece.byteOffset + piece.byteLength,
        ) as ArrayBuffer,
      );
      await new Promise((r) => setTimeout(r, 100));
    }
    let timeout = false;
    try {
      await wait(
        () =>
          session
            .getSnapshot()
            .tools.some(
              (t) => !known.has(t.callId) && t.status !== "working",
            ) && session.getSnapshot().phase === "listening",
        30000,
      );
    } catch {
      timeout = true;
    }
    const actual = controller.store.getState().scene;
    const tools = session
      .getSnapshot()
      .tools.filter((t) => !known.has(t.callId));
    const ok = !timeout && item.check(actual);
    if (ok) passed++;
    report.cases.push({
      id: item.id,
      utterance: item.text,
      heard: session.getSnapshot().heard,
      ok,
      elapsedMs: Date.now() - start,
      timeout,
      tools,
      scene: actual,
      audioSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await persist();
    console.log(
      (ok ? "PASS " : "FAIL ") + item.id + " " + (Date.now() - start) + "ms",
    );
  }
  report.passed = passed;
  report.total = corpus.length;
  report.outputBytes = outputBytes;
  report.result = passed >= 9 ? "PASS" : "FAILED";
  await persist();
  console.log(
    "Real speech corpus: " +
      passed +
      "/" +
      corpus.length +
      " first-pass assertions passed.",
  );
  if (passed < 9) process.exitCode = 1;
} catch (error) {
  report.result = "BLOCKED";
  report.error = error instanceof Error ? error.message : "Unknown error";
  await persist();
  console.error("Corpus blocked; see private report.");
  process.exitCode = 1;
} finally {
  session.stop();
}
