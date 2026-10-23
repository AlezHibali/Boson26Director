import { execFileSync } from "node:child_process";
const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
console.log(
  JSON.stringify(
    {
      repository: "https://github.com/AlezHibali/Boson26Director",
      revision: git(["rev-parse", "HEAD"]),
      dirty: !!git(["status", "--porcelain"]),
      note: "Use this exact committed revision in delivery. Publishing, pushing and competition submission are separate actions.",
    },
    null,
    2,
  ),
);
