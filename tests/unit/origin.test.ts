import { it, expect } from "vitest";
import { z } from "zod";
import { body } from "../../src/server/http";
it("uses actual request Host when Next dev normalizes request.url to localhost", async () => {
  const request = new Request("http://localhost:3000/api/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
    },
    body: "{}",
  });
  expect(await body(request, z.object({}).strict())).toEqual({});
});
it("rejects malformed/null origins and does not trust forwarded host", async () => {
  for (const origin of ["null", "https://attacker.example"]) {
    const request = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3000",
        origin,
        "x-forwarded-host": "attacker.example",
      },
      body: "{}",
    });
    await expect(body(request, z.object({}))).rejects.toMatchObject({
      code: "ORIGIN_REJECTED",
    });
  }
});
