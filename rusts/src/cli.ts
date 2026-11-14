import * as path from "path";
import * as fs from "fs";
import * as ts from "typescript";
import { transpileDir, diagnostics } from "./emitter.ts";

const [cmd, target] = process.argv.slice(2);

function collect(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        try {
            if (e.isDirectory()) out.push(...collect(p));
            else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
        } catch { }
    }
    return out.sort();
}

function report(d: ts.Diagnostic[]) {
    for (const diag of d) {
        const msg = ts.flattenDiagnosticMessageText(diag.messageText, " ");
        if (diag.file) {
            const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start!);
            console.error(`${diag.file.fileName}(${line + 1},${character + 1}): TS${diag.code}: ${msg}`);
        } else console.error(`TS${diag.code}: ${msg}`);
    }
}

if (cmd === "build") {
    const root = path.resolve(target);
    const outs = transpileDir(root);
    for (const o of outs) {
        fs.writeFileSync(o.file, o.code);
        console.log(`wrote ${path.relative(process.cwd(), o.file)}`);
    }
} else if (cmd === "check") {
    const root = path.resolve(target);
    report(diagnostics(root));
} else if (cmd === "run") {
    const { execSync } = await import("node:child_process");
    execSync("cargo run", { cwd: path.resolve(target, ".."), stdio: "inherit" });
} else {
    console.error("usage: rusts build|check|run <dir>");
    process.exit(1);
}
