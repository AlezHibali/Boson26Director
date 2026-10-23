import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Take } from "../../../src/domain/take";
export async function prepare(page: Page) {
  const records: Take[] = [],
    requests: any[] = [],
    outputs: any[] = [];
  let ws: WebSocketRoute | undefined;
  const portraits = new Map<string, string>();
  const fixture = (input: any, base?: Take): Take => ({
    id: randomUUID(),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
    baseTakeId: base?.id || null,
    status: "queued",
    videoId: "video_" + records.length,
    progress: 0,
    error: null,
    input: base
      ? { ...structuredClone(base.input), emotion: input.overrides.emotion }
      : {
          scene: input.scene,
          emotion: input.scene.performance.emotion,
          voice: "default",
          model: "higgs-avatar",
          ttsModel: "higgs-tts-3",
          size: "640x640",
          reference: {
            hash: "fixture-reference",
            version: "portrait-v1",
            mode: "captured",
            appearanceKey: JSON.stringify([
              input.scene.actor.presetId,
              input.scene.actor.outfit,
              input.scene.actor.appearance.EyeSize,
              input.scene.actor.appearance.FaceWidth,
            ]),
          },
        },
    inputHash: "fixture-input",
    invariantHash: base?.invariantHash || "fixture-invariant",
  });
  await page.route("**/api/takes**", async (route) => {
    const url = new URL(route.request().url()),
      parts = url.pathname.split("/").filter(Boolean);
    if (parts[3] === "archive") {
      const t = records.find((t) => t.id === parts[2])!;
      t.archive = {
        hash: "fixture",
        bytes: 17100,
        storedAt: new Date().toISOString(),
        source: "provider",
      };
      return route.fulfill({ json: t });
    }
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      requests.push({ path: url.pathname, body });
      const existing = records.find((t) => t.requestId === body.requestId);
      if (existing) return route.fulfill({ status: 202, json: existing });
      const base = records.find((t) => t.id === body.baseTakeId),
        t = fixture(body, base);
      records.unshift(t);
      portraits.set(t.id, base ? portraits.get(base.id)! : body.portrait);
      return route.fulfill({ status: 202, json: t });
    }
    if (parts.length === 2) return route.fulfill({ json: { takes: records } });
    const t = records.find((t) => t.id === parts[2]);
    if (!t)
      return route.fulfill({
        status: 404,
        json: { error: { message: "missing" } },
      });
    if (parts[3] === "portrait")
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(portraits.get(t.id)!.split(",")[1], "base64"),
      });
    if (parts[3] === "content")
      return route.fulfill({
        contentType: "video/mp4",
        body: readFileSync("tests/fixtures/playback.mp4"),
      });
    return route.fulfill({ json: t });
  });
  await page.route("**/api/realtime/session", (r) =>
    r.fulfill({
      json: { value: "bai-eph-fixture", expires_at: Date.now() / 1000 + 300 },
    }),
  );
  await page.routeWebSocket("wss://api.boson.ai/v1/realtime", (socket) => {
    ws = socket;
    socket.onMessage((raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === "session.update")
        socket.send(
          JSON.stringify({
            type: e.session.model ? "session.created" : "session.updated",
          }),
        );
      if (e.item?.type === "function_call_output")
        outputs.push(JSON.parse(e.item.output));
      if (e.type === "response.create") {
        const id = "reply-" + outputs.length;
        socket.send(
          JSON.stringify({ type: "response.created", response: { id } }),
        );
        socket.send(
          JSON.stringify({
            type: "response.done",
            response: { id, status: "completed", output: [] },
          }),
        );
      }
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("asset-load-status")).toContainText("就绪", {
    timeout: 30000,
  });
  await expect(page.getByTestId("action")).toBeEnabled();
  return {
    records,
    requests,
    portraits,
    outputs,
    event: (value: unknown) => ws!.send(JSON.stringify(value)),
    emit: (responseId: string, callId: string, name: string, args: unknown) => {
      ws!.send(
        JSON.stringify({
          type: "response.created",
          response: { id: responseId },
        }),
      );
      ws!.send(
        JSON.stringify({
          type: "response.done",
          response: {
            id: responseId,
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: callId,
                name,
                arguments: JSON.stringify(args),
              },
            ],
          },
        }),
      );
    },
    complete: (t: Take) => {
      t.status = "completed";
      t.progress = 100;
    },
  };
}
