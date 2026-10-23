import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
const phases = [
  "typecheck",
  "test:unit",
  "build",
  "check:secrets",
  "test:e2e",
  "test:demo",
] as const;
const results: {
  phase: string;
  ok: boolean;
  durationMs: number;
  browserStats?: unknown;
}[] = [];
const startedAt = new Date().toISOString();
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = !!execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).trim();
let browserCounts: unknown = null;
for (const phase of phases) {
  console.log("\nVERIFY " + phase);
  const start = performance.now();
  const exit = await new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      [process.env.npm_execpath!, "run", phase],
      {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          PLAYWRIGHT_PRODUCTION: "1",
          STAGE5_EVIDENCE: "1",
        },
      },
    );
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
  const row: {
    phase: string;
    ok: boolean;
    durationMs: number;
    browserStats?: unknown;
  } = {
    phase,
    ok: exit === 0,
    durationMs: Math.round(performance.now() - start),
  };
  if (phase.startsWith("test:") && phase !== "test:unit")
    try {
      row.browserStats = JSON.parse(
        await readFile("test-results/results.json", "utf8"),
      ).stats;
    } catch {}
  results.push(row);
  if (exit !== 0) {
    process.exitCode = 1;
    break;
  }
}
try {
  const r = JSON.parse(await readFile("test-results/results.json", "utf8"));
  browserCounts = r.stats;
} catch {}
await mkdir("docs/evidence", { recursive: true });
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  "docs/evidence/stage5-verification.json",
  JSON.stringify(
    {
      startedAt,
      finishedAt: new Date().toISOString(),
      revision,
      dirty,
      environment: {
        node: process.versions.node,
        os: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        next: pkg.dependencies.next,
      },
      mode: "Local production build, isolated test DB and empty provider key. HTTP/WS fixtures; no paid calls.",
      results,
      browserCounts,
      physicalMicrophone: "pending human acceptance",
      publicDeployment: "not performed",
    },
    null,
    2,
  ),
);
console.log(
  "\nVerification " +
    (process.exitCode ? "FAILED" : "PASSED") +
    "; docs/evidence/stage5-verification.json",
);
