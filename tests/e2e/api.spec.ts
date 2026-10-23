import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("A21/A22: isolated HTTP server has no paid credential, validates origin and exposes safe diagnostics", async ({
  request,
}) => {
  const d = await request.get("/api/diagnostics");
  expect(d.ok()).toBe(true);
  expect((await d.json()).configured).toBe(false);
  expect(d.headers()["cache-control"]).toBe("no-store");
  const metrics = await request.get("/api/metrics");
  expect(metrics.ok()).toBe(true);
  expect(JSON.stringify(await metrics.json())).not.toMatch(
    /bai-|Authorization|Bearer /,
  );
  for (const [path, body] of [
    ["/api/takes", {}],
    ["/api/takes/retake", {}],
    ["/api/avatar", {}],
  ])
    expect((await request.post(path as string, { data: body })).status()).toBe(
      400,
    );
  expect(
    (
      await request.post("/api/realtime/session", {
        data: {},
        headers: { Origin: "https://foreign.invalid" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (await request.post("/api/realtime/session", { data: {} })).status(),
  ).toBe(503);
  expect((await request.get("/api/takes/" + randomUUID())).status()).toBe(404);
  expect(
    (await request.get("/api/takes/" + randomUUID() + "/content")).status(),
  ).toBe(404);
  expect(
    (
      await request.post("/api/takes/" + randomUUID() + "/archive", {
        data: {},
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await request.post("/api/takes/" + randomUUID() + "/archive", {
        data: {},
        headers: { Origin: "https://foreign.invalid" },
      })
    ).status(),
  ).toBe(403);
  const history = await request.get("/api/takes");
  expect(history.ok()).toBe(true);
  expect(JSON.stringify(await history.json())).not.toMatch(
    /bai-|Authorization/,
  );
});
