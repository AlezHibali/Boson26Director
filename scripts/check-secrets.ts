import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
try {
  process.loadEnvFile(".env.local");
} catch {}
const key = process.env.BOSON_API_KEY;
if (!key)
  throw new Error(
    "Local key not configured; cannot check exact secret exclusion.",
  );
execFileSync("git", ["check-ignore", "-q", ".env.local"]);
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const paths = [...listed];
async function walk(dir: string) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = dir + "/" + item.name;
    if (item.isDirectory()) await walk(path);
    else paths.push(path);
  }
}
await walk(".next/static");
const bad: string[] = [];
for (const path of paths) {
  if ((await readFile(path)).includes(Buffer.from(key))) bad.push(path);
}
if (bad.length)
  throw new Error(
    "Configured secret found in non-ignored files or browser output: " +
      bad.join(", "),
  );
console.log(
  "PASS: .env.local is Git-ignored; configured master key absent from " +
    paths.length +
    " non-ignored files and browser build artifacts.",
);
