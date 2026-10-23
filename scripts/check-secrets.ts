import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
try {
  process.loadEnvFile(".env.local");
} catch {}
const key = process.env.BOSON_API_KEY;
execFileSync("git", ["check-ignore", "-q", ".env.local"]);
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
if (
  listed.some((p) => /^\.env(?!\.example$)/.test(p) || p.startsWith(".data/"))
)
  throw Error("Private configuration or data is tracked.");
const paths = [...new Set(listed)];
async function walk(dir: string) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + item.name;
    if (item.isDirectory()) await walk(p);
    else paths.push(p);
  }
}
await walk(".next/static");
const bad: string[] = [];
for (const p of paths) {
  const value = await readFile(p);
  if (
    (key && value.includes(Buffer.from(key))) ||
    /\bbai-(?!eph-)[A-Za-z0-9_-]{40,}\b/.test(value.toString("utf8"))
  )
    bad.push(p);
}
if (bad.length)
  throw Error(
    "Potential provider credential found in files: " + bad.join(", "),
  );
console.log(
  "PASS: private files ignored; " +
    (key ? "exact configured key and " : "") +
    "provider-key patterns absent from " +
    paths.length +
    " source and browser artifact files.",
);
