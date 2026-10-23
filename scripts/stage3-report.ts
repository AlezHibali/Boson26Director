import { readFile, writeFile } from "node:fs/promises";
const dir = "docs/evidence/private/stage3";
const corpus = JSON.parse(await readFile(dir + "/corpus-report.json", "utf8"));
const browser = JSON.parse(
  await readFile(dir + "/browser-report.json", "utf8"),
);
const barge = JSON.parse(await readFile(dir + "/barge-report.json", "utf8"));
if ([corpus, browser, barge].some((report) => report.result !== "PASS"))
  throw new Error("A real service acceptance report has not passed.");
const output = {
  date: corpus.date,
  mode: "Real Boson services with generated test speech; not a human microphone acceptance.",
  corpus: {
    passed: corpus.passed,
    total: corpus.total,
    cases: corpus.cases.map((row: any) => ({
      id: row.id,
      utterance: row.utterance,
      heard: row.heard,
      ok: row.ok,
      elapsedMs: row.elapsedMs,
      tools: row.tools.map((tool: any) => ({
        name: tool.name,
        status: tool.status,
      })),
      observed: {
        presetId: row.scene.actor.presetId,
        outfit: row.scene.actor.outfit,
        rotationY: row.scene.actor.rotationY,
        appearance: row.scene.actor.appearance,
        camera: row.scene.camera,
        lights: row.scene.lights,
        performance: row.scene.performance,
      },
    })),
  },
  browser: {
    result: browser.result,
    heard: browser.heard,
    replyBufferStarts: browser.replyBufferStarts,
    tracksReleased: browser.tracksReleased,
    actor: browser.scene.actor,
    renderer: browser.render.renderer,
  },
  barge: {
    result: barge.result,
    replySourcesStopped: barge.replyStops,
    truncationRequests: barge.truncationRequests,
    localStopMs: barge.runtime.interruptionMs,
    providerErrors: barge.providerErrors,
    actorRotationY: barge.scene.actor.rotationY,
    cameraDistance: barge.scene.camera.distance,
  },
};
await writeFile(
  "docs/evidence/stage3-live-summary.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  "Wrote sanitized public report: " +
    corpus.passed +
    "/" +
    corpus.total +
    " real speech cases, real browser and real barge-in.",
);
