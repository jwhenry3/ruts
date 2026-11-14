// dev loop without the npm.cmd batch wrapper — running `node scripts/dev.mjs`
// directly keeps cmd.exe out of the process tree, so Ctrl+C reaches nestrs
// cleanly (its console handler prints "[nest] shutting down" and exits 0)
// instead of cmd asking "Terminate batch job (Y/N)?".
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const build = spawnSync(process.execPath, ["ruts/src/cli.ts", "build", "nestrs/src"], { cwd: root, stdio: "inherit" });
process.exitCode = build.status ?? 1;
if (process.exitCode === 0) {
    const run = spawnSync("cargo", ["run", "--manifest-path", "nestrs/Cargo.toml"], { cwd: root, stdio: "inherit" });
    process.exitCode = run.status ?? 1;
}
