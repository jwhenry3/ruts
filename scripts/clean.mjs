import { readdirSync, statSync, existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (extname(e.name) !== ".rs") continue;
    if (e.name === "mod.rs" || existsSync(p.replace(/\.rs$/, ".ts"))) unlinkSync(p);
  }
}
for (const dir of ["nestrs/src", "ruts/examples"]) if (existsSync(dir)) walk(dir);
