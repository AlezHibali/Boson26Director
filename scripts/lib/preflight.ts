import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export type Check = {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
};
export async function preflight(root: string) {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], message: string) =>
    checks.push({ name, status, message });
  add(
    "node",
    Number(process.versions.node.split(".")[0]) >= 24 ? "pass" : "fail",
    "Node " + process.versions.node + "; Node 24+ required.",
  );
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("SELECT 1");
    db.close();
    add("sqlite", "pass", "Built-in SQLite available.");
  } catch {
    add("sqlite", "fail", "Built-in SQLite unavailable; install Node 24+.");
  }
  for (const file of [
    "package-lock.json",
    "public/actors/mira.glb",
    "public/actors/ren.glb",
    "public/actors/LICENSE.txt",
  ])
    add(
      file,
      existsSync(join(root, file)) ? "pass" : "fail",
      "Required project artifact " + file,
    );
  let local = "";
  try {
    local = readFileSync(join(root, ".env.local"), "utf8");
  } catch {}
  const match = local.match(
    /^BOSON_API_KEY[ \t]*=[ \t]*(?:["']([^"'\r\n]*)["']|([^#\r\n]*))/m,
  );
  const configured = Object.hasOwn(process.env, "BOSON_API_KEY")
    ? !!process.env.BOSON_API_KEY?.trim()
    : !!(match?.[1] ?? match?.[2])?.trim();
  add(
    "provider",
    configured ? "pass" : "warn",
    configured
      ? "Server credential configured; availability is not checked."
      : "No server credential. Manual staging works; configure .env.local for voice and paid generation.",
  );
  const unsafe =
    !!process.env.NEXT_PUBLIC_BOSON_API_KEY ||
    /^NEXT_PUBLIC_\w*(?:BOSON|API_KEY)\w*\s*=/m.test(local);
  add(
    "public-credential",
    unsafe ? "fail" : "pass",
    unsafe
      ? "Remove public credential variables and rebuild before sharing."
      : "No public provider key variable detected.",
  );
  for (const binary of ["ffmpeg", "ffprobe"]) {
    const p = spawnSync(binary, ["-version"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    add(
      binary,
      p.status === 0 ? "pass" : "warn",
      p.status === 0
        ? "Available for live media verification."
        : "Optional; install for live media verification.",
    );
  }
  return {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    node: process.versions.node,
    providerConfigured: configured,
  };
}
