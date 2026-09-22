// Identify the generator revision for clone-and-build instructions. Only a
// committed, published revision can reproduce a dataset on another machine.
import {execFileSync} from "node:child_process";
import path from "node:path";

export function motionFullV1SourceSnapshot(repoRoot, inputs) {
    const git = args => execFileSync("git", args, {cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
    const revision = git(["rev-parse", "HEAD"]).trim();
    const requested = [...new Set([
        ...Object.keys(inputs).filter(p => !p.startsWith("unused-target:")).map(p => path.relative(repoRoot, path.resolve(repoRoot, p))),
        "package.json", "package-lock.json", "benchmarks/botbench/run-motion-full-v1.mjs",
        "benchmarks/botbench/motion-full-v1-source.mjs", "benchmarks/botbench/run-motion-v1.mjs",
    ].filter(p => !p.startsWith("../") && !p.startsWith("node_modules/")))].sort();
    const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...requested])
        .split("\0").filter(Boolean);
    const localChanges = Boolean(git(["status", "--porcelain", "--untracked-files=all", "--", ...files]).trim());
    const published = Boolean(git(["branch", "-r", "--contains", revision, "origin/*"]).trim());
    return {revision, localChanges, published};
}
