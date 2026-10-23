import { preflight } from "./lib/preflight";
const report = await preflight(process.cwd());
if (process.argv.includes("--json"))
  console.log(JSON.stringify(report, null, 2));
else
  for (const c of report.checks)
    console.log(c.status.toUpperCase() + " " + c.name + ": " + c.message);
if (!report.ok) process.exitCode = 1;
