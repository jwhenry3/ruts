import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { allDiagnostics } = require_("./checks.cjs") as { allDiagnostics: (sf: ts.SourceFile) => ts.Diagnostic[] };

// ---------- helpers ----------

function snake(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toLowerCase();
}

function indent(code: string, pad = "    "): string {
    return code.split("\n").map(l => l.length ? pad + l : l).join("\n");
}

function modName(fileTs: string): string {
    return path.basename(fileTs).replace(/\.ts$/, "").replace(/[^A-Za-z0-9_]/g, "_");
}

const EXC: Record<string, string> = {
    BadRequestException: "bad_request",
    UnauthorizedException: "unauthorized",
    ForbiddenException: "forbidden",
    NotFoundException: "not_found",
    ConflictException: "conflict",
    InternalServerErrorException: "internal",
};

interface RouteMeta { http: string; path: string; method: ts.MethodDeclaration; guards: string[]; }
interface CtrlMeta { prefix: string; interceptors: string[]; routes: RouteMeta[]; }
interface ModuleMeta { imports: string[]; controllers: string[]; providers: string[]; }

interface Ctx {
    checker: ts.TypeChecker;
    program: ts.Program;
    rootDir: string;
    files: ts.SourceFile[];
    nestAlias: string;
    fail(msg: string, node?: ts.Node): never;
    moduleOf: Map<string, ModuleMeta>;
    ctrlOf: Map<string, CtrlMeta>;
    injectables: Set<string>;
    classFile: Map<string, string>;         // class name -> source file path
    aliasOf: Map<string, string>;           // symbol -> module ref path (use target)
    typeAliasOf: Map<string, string>;       // symbol -> type path (crate::x::T)
    fieldsOf: Map<ts.ClassDeclaration, Map<string, { node?: ts.TypeNode; arc?: boolean }>>; // field -> declared type
    methodsOf: Map<ts.ClassDeclaration, Set<string>>;
    dtoWithValidate: Set<string>;
    mut: Set<string>;                        // mutated locals in current fn
    guards: Set<string>;                     // vars bound to .lock() guards
    renames: Map<string, string>;            // ident renames (e.g. c -> ctx)
    curRetIsResult: boolean;
    curRetFirstIsAny: boolean;
    curRetIsVoidResult: boolean;
    curRetType: string;
}

// ---------- main entry ----------

// ambient declarations: ruts' own types + the project's types/ dir next to rootDir
function ambientTypes(rootDir: string): string[] {
    const dirs = [
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../types"),
        path.resolve(rootDir, "../types"),
    ];
    const out: string[] = [];
    for (const d of dirs) {
        try {
            for (const f of fs.readdirSync(d)) if (f.endsWith(".d.ts")) out.push(path.join(d, f));
        } catch { /* no types dir */ }
    }
    return out;
}

export function transpileDir(rootDir: string): { file: string; code: string }[] {
    const files = collectTs(rootDir);
    const program = ts.createProgram([...files, ...ambientTypes(rootDir)], {
        strict: false, strictNullChecks: true, experimentalDecorators: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS, noEmit: true, skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const ctx: Ctx = {
        checker, program, rootDir,
        files: files.map(f => program.getSourceFile(f)!).filter(Boolean),
        nestAlias: "nest",
        fail(msg, node) {
            const pos = node ? node.getSourceFile().fileName + ":" + node.getStart() : "";
            throw new Error(`ruts: ${msg} ${pos}`);
        },
        moduleOf: new Map(), ctrlOf: new Map(), injectables: new Set(),
        classFile: new Map(), aliasOf: new Map(), typeAliasOf: new Map(),
        fieldsOf: new Map(), methodsOf: new Map(), dtoWithValidate: new Set(),
        mut: new Set(), guards: new Set(), renames: new Map(),
        curRetIsResult: false, curRetFirstIsAny: false, curRetIsVoidResult: false,
        curRetType: "",
    };

    // pass 0: collect classes + decorators across all files
    for (const sf of ctx.files) {
        sf.forEachChild(node => {
            if (ts.isClassDeclaration(node) && node.name) {
                collectClass(ctx, node, sf.fileName);
            }
        });
    }

    const out: { file: string; code: string }[] = [];
    for (const sf of ctx.files) {
        out.push({ file: rsPath(sf.fileName), code: emitFile(ctx, sf) });
    }
    // mod.rs per directory (non-root)
    const dirs = new Map<string, string[]>();
    for (const f of files) {
        const d = path.dirname(f);
        if (path.resolve(d) !== path.resolve(rootDir)) {
            if (!dirs.has(d)) dirs.set(d, []);
            dirs.get(d)!.push(modName(f));
        }
    }
    for (const [dir, mods] of dirs) {
        const subs = new Set<string>();
        for (const d2 of dirs.keys()) {
            if (path.dirname(d2) === dir) subs.add(path.basename(d2));
        }
        let code = "";
        for (const m of mods.sort()) code += `pub mod ${m};\npub use ${m}::*;\n`;
        for (const s of subs) code += `pub mod ${s};\n`;
        out.push({ file: path.join(dir, "mod.rs"), code });
    }
    return out;
}

function collectTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        try {
            if (e.isDirectory()) out.push(...collectTs(p));
            else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
        } catch { /* skip unreadable */ }
    }
    return out.sort();
}

function rsPath(tsPath_: string): string {
    return tsPath_.replace(/\.ts$/, ".rs").replace(/([\\/])([^\\/]+)\.rs$/, (_m, sep, b) => sep + b.replace(/\./g, "_") + ".rs");
}

// ---------- pass 0: classes & decorators ----------

function collectClass(ctx: Ctx, node: ts.ClassDeclaration, file: string) {
    const name = node.name!.text;
    ctx.classFile.set(name, file);
    const decs = ts.getDecorators?.(node) ?? [];
    const fields = new Map<string, { node?: ts.TypeNode; arc?: boolean }>();
    const methods = new Set<string>();
    for (const m of node.members) {
        if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
            fields.set(m.name.text, { node: m.type });
        }
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
            methods.add(m.name.text);
            if (m.name.text === "Validate") ctx.dtoWithValidate.add(name);
        }
        if (ts.isConstructorDeclaration(m)) {
            for (const p of m.parameters) {
                const mods = ts.getModifiers(p) ?? [];
                if (mods.some(x => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.PublicKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword || x.kind === ts.SyntaxKind.ReadonlyKeyword)) {
                    if (ts.isIdentifier(p.name)) fields.set(p.name.text, { node: p.type, arc: true });
                }
            }
        }
    }
    ctx.fieldsOf.set(node, fields);
    ctx.methodsOf.set(node, methods);

    for (const d of decs) {
        if (!ts.isCallExpression(d.expression) && !ts.isIdentifier(d.expression)) continue;
        const callee = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
        const dname = ts.isIdentifier(callee) ? callee.text : "";
        if (dname === "Module" && ts.isCallExpression(d.expression)) {
            const arg = d.expression.arguments[0];
            const meta: ModuleMeta = { imports: [], controllers: [], providers: [] };
            if (arg && ts.isObjectLiteralExpression(arg)) {
                for (const p of arg.properties) {
                    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
                    const key = p.name.text as keyof ModuleMeta;
                    if (key in meta && ts.isArrayLiteralExpression(p.initializer)) {
                        meta[key] = p.initializer.elements.map(e => e.getText());
                    }
                }
            }
            ctx.moduleOf.set(name, meta);
        }
        if (dname === "Controller") {
            const arg = ts.isCallExpression(d.expression) ? d.expression.arguments[0] : undefined;
            const meta: CtrlMeta = {
                prefix: arg && ts.isStringLiteral(arg) ? arg.text : "/",
                interceptors: [], routes: [],
            };
            for (const d2 of decs) {
                if (ts.isCallExpression(d2.expression) && ts.isIdentifier(d2.expression.expression)) {
                    const n2 = d2.expression.expression.text;
                    if (n2 === "UseInterceptors") {
                        meta.interceptors.push(...d2.expression.arguments.map(a => a.getText()));
                    }
                }
            }
            for (const m of node.members) {
                if (!ts.isMethodDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) continue;
                const mdecs = ts.getDecorators?.(m) ?? [];
                for (const md of mdecs) {
                    if (!ts.isCallExpression(md.expression) || !ts.isIdentifier(md.expression.expression)) continue;
                    const hn = md.expression.expression.text;
                    if (["Get", "Post", "Patch", "Delete"].includes(hn)) {
                        const pa = md.expression.arguments[0];
                        const route: RouteMeta = {
                            http: hn.toLowerCase(),
                            path: pa && ts.isStringLiteral(pa) ? pa.text : "/",
                            method: m, guards: [],
                        };
                        for (const md2 of mdecs) {
                            if (ts.isCallExpression(md2.expression) && ts.isIdentifier(md2.expression.expression) && md2.expression.expression.text === "UseGuards") {
                                route.guards.push(...md2.expression.arguments.map(a => a.getText()));
                            }
                        }
                        meta.routes.push(route);
                    }
                }
            }
            ctx.ctrlOf.set(name, meta);
        }
        if (dname === "Injectable") ctx.injectables.add(name);
    }
}

// ---------- type mapping ----------

function emitType(ctx: Ctx, t: ts.TypeNode, pos: "param" | "ret" | "field" | "general"): string {
    switch (t.kind) {
        case ts.SyntaxKind.StringKeyword: return pos === "param" ? "&str" : "String";
        case ts.SyntaxKind.BooleanKeyword: return "bool";
        case ts.SyntaxKind.VoidKeyword: return "()";
        case ts.SyntaxKind.NumberKeyword: return "i32";
        case ts.SyntaxKind.AnyKeyword: return "serde_json::Value";
        case ts.SyntaxKind.NullKeyword: return "()";
    }
    if (ts.isTypeReferenceNode(t)) {
        const name = t.typeName.getText();
        const args = t.typeArguments ?? ts.factory.createNodeArray();
        const g = (i: number) => args[i] ? emitType(ctx, args[i], "general") : "()";
        switch (name) {
            case "Int32": case "Int": return "i32";
            case "Int64": return "i64";
            case "Float32": return "f32";
            case "Float64": return "f64";
            case "Usize": return "usize";
            case "Bool": return "bool";
            case "Str": return pos === "param" ? "&str" : "String";
            case "Any": return "serde_json::Value";
            case "Error": return "nest::Error";
            case "Void": case "Null": return "()";
            case "Ptr": {
                const inner = args[0] ? args[0].getText() : "";
                if (inner === "nest.Ctx" || inner.endsWith(".Ctx")) return "&mut nest::Ctx";
                return g(0);
            }
            case "Mutex": return `std::sync::Mutex<${g(0)}>`;
            case "Channel": return `nest::Chan<${g(0)}>`;
            case "Array": return `Vec<${g(0)}>`;
            case "Promise": return g(0);
            default: {
                const resolved = resolveTypePath(ctx, name);
                return resolved;
            }
        }
    }
    if (ts.isArrayTypeNode(t)) return `Vec<${emitType(ctx, t.elementType, "general")}>`;
    if (ts.isTupleTypeNode(t)) {
        const els = [...t.elements];
        if (els.length === 2) {
            const last = els[1].getText();
            if (last.includes("Ptr<")) {
                // framework-internal convention: [A, Ptr<Error> | null] -> (A, Option<Error>) real tuple
                return `(${emitType(ctx, els[0], "general")}, Option<nest::Error>)`;
            }
            const stripped = last.replace(/\s*\|\s*(null|undefined)/g, "").trim();
            if (stripped === "Error" || stripped.endsWith("Error")) {
                return `Result<${emitType(ctx, els[0], "general")}, nest::Error>`;
            }
        }
        return `(${els.map(e => emitType(ctx, e, "general")).join(", ")})`;
    }
    if (ts.isUnionTypeNode(t)) {
        const nonNull = t.types.filter(x => x.kind !== ts.SyntaxKind.NullKeyword && x.kind !== ts.SyntaxKind.UndefinedKeyword);
        if (nonNull.length === 1 && nonNull.length < t.types.length) {
            return `Option<${emitType(ctx, nonNull[0], "general")}>`;
        }
        ctx.fail(`unsupported union type '${t.getText()}' — Rust has enums, not TS unions`, t);
    }
    if (ts.isTypeLiteralNode(t)) return "serde_json::Value";
    return "serde_json::Value";
}

// resolve a type/symbol to a path usable in the given file's module
function resolveTypePath(ctx: Ctx, name: string): string {
    if (name.includes(".")) {
        const [ns, mem] = name.split(".");
        if (ns === ctx.nestAlias || ns === "nest") return `nest::${mem}`;
        return `${ns}::${mem}`;
    }
    const file = ctx.classFile.get(name);
    if (!file) return name; // same module / builtin
    return pathForSymbol(ctx, name, file);
}

function relModuleChain(ctx: Ctx, targetFile: string, fromFile: string): string {
    // produce the module path to `name` defined in targetFile, used inside fromFile
    const targetDir = path.dirname(targetFile);
    const fromDir = path.dirname(fromFile);
    const rel = path.relative(fromDir, targetDir).replace(/\\/g, "/");
    const mod = modName(targetFile);
    if (rel === "" || rel === ".") return `super::${mod}::`;
    if (!rel.startsWith("..")) return `super::${rel.replace(/\//g, "::")}::${mod}::`;
    // go up to root, then down
    const up = rel.split("/").filter(s => s === "..").length;
    const down = rel.split("/").filter(s => s !== ".." && s !== "");
    const rootDepth = path.relative(ctx.rootDir, fromDir).split(path.sep).filter(Boolean).length;
    if (up === rootDepth) {
        // from a subdir to root or sibling dir
        if (down.length === 0) return `crate::${mod}::`;
        return `crate::${down.join("::")}::${mod}::`;
    }
    return `crate::${path.relative(ctx.rootDir, targetDir).split(path.sep).join("::")}::${mod}::`;
}

function pathForSymbol(ctx: Ctx, name: string, targetFile: string): string {
    // called during file emission — ctx.curFile must be set
    const chain = relModuleChain(ctx, targetFile, (ctx as any).curFile ?? targetFile);
    // mod.rs re-exports: sibling via super::Name; subdir via super::sub::Name; up via crate::...
    const targetDir = path.dirname(targetFile);
    const fromFile = (ctx as any).curFile ?? targetFile;
    const fromDir = path.dirname(fromFile);
    const atRoot = path.resolve(fromDir) === path.resolve(ctx.rootDir);
    if (path.resolve(targetDir) === path.resolve(fromDir)) {
        return atRoot ? `crate::${name}` : `super::${name}`;
    }
    const rel = path.relative(fromDir, targetDir).replace(/\\/g, "/");
    if (rel === "" || rel === ".") return `super::${name}`;
    if (!rel.startsWith("..")) {
        const mid = rel === "" || rel === "." ? "" : `${rel.split("/").join("::")}::`;
        return `${atRoot ? "crate" : "super"}::${mid}${name}`;
    }
    const fromRoot = path.relative(ctx.rootDir, targetDir).split(path.sep).filter(Boolean);
    return fromRoot.length === 0 ? `crate::${name}` : `crate::${fromRoot.join("::")}::${name}`;
}

// ---------- file emission ----------

function emitFile(ctx: Ctx, sf: ts.SourceFile): string {
    (ctx as any).curFile = sf.fileName;
    const isRoot = path.resolve(path.dirname(sf.fileName)) === path.resolve(ctx.rootDir);
    const isMain = isRoot && hasTopLevelStmts(sf);
    let code = "// generated by ruts — do not edit\n#![allow(dead_code, unused_mut, unused_variables, unused_imports, clippy::all)]\n";
    const body: string[] = [];
    const uses = new Set<string>();

    // imports
    for (const node of sf.statements.filter(ts.isImportDeclaration)) {
        const spec = node.moduleSpecifier.getText().replace(/^['"]|['"]$/g, "");
        if (spec === "nest" || spec.endsWith("/nest")) {
            const clause = node.importClause;
            ctx.nestAlias = clause?.name?.text
                ?? (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : "nest");
            continue;
        }
        const target = resolveImport(sf.fileName, spec, ctx.files.map(f => f.fileName));
        if (!target) { uses.add(`// unresolved import '${spec}'`); continue; }
        const names = namedImports(node);
        const clause = node.importClause;
        if (clause?.name) {
            // default import of a local file = module alias — rare; skip
        }
        for (const n of names) {
            const p = ctx.moduleOf.has(n) ? factoryPath(ctx, n) : pathForSymbol(ctx, n, target);
            uses.add(`use ${p};`);
        }
    }

    for (const node of sf.statements) {
        if (ts.isImportDeclaration(node)) continue;
        if (ts.isClassDeclaration(node) && node.name) {
            const cls = emitClass(ctx, node, sf);
            if (cls) body.push(cls);
            continue;
        }
        if (ts.isInterfaceDeclaration(node) && node.name) {
            body.push(emitInterface(ctx, node));
            continue;
        }
        if (ts.isFunctionDeclaration(node) && node.name) {
            body.push(emitFn(ctx, node));
            continue;
        }
        if (ts.isEnumDeclaration(node)) {
            body.push(emitEnum(ctx, node));
            continue;
        }
        // any other top-level statement is collected into fn main below (isMain)
        // or skipped for library files
    }

    if (isMain) {
        // top-level statements -> fn main body
        const stmts = sf.statements.filter(s => !ts.isImportDeclaration(s) && !ts.isClassDeclaration(s) && !ts.isInterfaceDeclaration(s) && !ts.isFunctionDeclaration(s) && !ts.isEnumDeclaration(s));
        collectMut(ctx, stmts);
        let main = "fn main() {\n";
        for (const s of stmts) main += indent(emitStmt(ctx, s));
        main += "}\n";
        body.push(main);
    }

    if (isMain) {
        // mod decls for siblings + subdirs
        let mods = "";
        for (const f of ctx.files) {
            // siblings with top-level statements are their own main — not submodules
            if (path.resolve(path.dirname(f.fileName)) === path.resolve(ctx.rootDir) && f.fileName !== sf.fileName && !hasTopLevelStmts(f)) {
                const m = modName(f.fileName);
                mods += `pub mod ${m};\npub use ${m}::*;\n`;
            }
        }
        const subdirs = new Set<string>();
        for (const f of ctx.files) {
            const rel = path.relative(ctx.rootDir, path.dirname(f.fileName));
            if (rel && !rel.startsWith("..")) subdirs.add(rel.split(path.sep)[0]);
        }
        for (const d of [...subdirs].sort()) mods += `pub mod ${snake(d)};\n`;
        code += mods;
    }

    if (uses.size) code += [...uses].sort().join("\n") + "\n";
    code += "\n" + body.join("\n");
    return code;
}

function hasTopLevelStmts(sf: ts.SourceFile): boolean {
    return sf.statements.some(s =>
        !ts.isImportDeclaration(s) && !ts.isClassDeclaration(s) &&
        !ts.isInterfaceDeclaration(s) && !ts.isFunctionDeclaration(s) && !ts.isEnumDeclaration(s));
}

function emitInterface(ctx: Ctx, node: ts.InterfaceDeclaration): string {
    const name = node.name.text;
    const fields: string[] = [];
    for (const m of node.members) {
        if (!ts.isPropertySignature(m) || !m.type) ctx.fail("ruts interfaces may only declare fields", m);
        fields.push(`    pub ${snake(m.name!.getText())}: ${emitType(ctx, m.type, "field")}`);
    }
    return `#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]\npub struct ${name} {\n${fields.join(",\n")}\n}\n`;
}

function namedImports(node: ts.ImportDeclaration): string[] {
    const nb = node.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) return nb.elements.map(e => (e.propertyName ?? e.name).text);
    return [];
}

function resolveImport(fromFile: string, spec: string, all: string[]): string | null {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const cand of [base + ".ts", path.join(base, "index.ts")]) {
        const hit = all.find(f => path.resolve(f) === cand);
        if (hit) return hit;
    }
    return null;
}

// ---------- class emission ----------

function emitClass(ctx: Ctx, node: ts.ClassDeclaration, sf: ts.SourceFile): string {
    const name = node.name!.text;
    if (ctx.moduleOf.has(name)) return emitModuleFactory(ctx, node, sf);
    const fields = ctx.fieldsOf.get(node)!;
    const isDto = !ctx.ctrlOf.has(name) && !ctx.injectables.has(name);
    let out = "";

    // struct
    if (isDto) out += "#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]\n";
    if (fields.size === 0) {
        out += `pub struct ${name};\n\n`;
    } else {
        out += `pub struct ${name} {\n`;
        for (const [fname, f] of fields) {
            const ftype = f.arc ? `std::sync::Arc<${f.node ? emitType(ctx, f.node, "field") : "serde_json::Value"}>` : (f.node ? emitType(ctx, f.node, "field") : "i32");
            out += `    ${isDto ? "pub " : ""}${snake(fname)}: ${ftype},\n`;
        }
        out += "}\n\n";
    }

    // impl block
    out += `impl ${name} {\n`;
    let emittedNew = false;
    for (const m of node.members) {
        if (ts.isConstructorDeclaration(m)) {
            out += emitCtor(ctx, node, m, fields);
            emittedNew = true;
            continue;
        }
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
            const mname = m.name.text;
            if (mname === "Validate") continue; // emitted as trait impl
            if (ctx.ctrlOf.has(name) && isRouteMethod(ctx, name, mname)) {
                // regular method — still emitted (called by handler closure)
            }
            if (mname === "canActivate" || mname === "CanActivate") continue; // Guard impl below
            if (mname === "intercept") continue;                              // Interceptor impl below
            out += emitMethod(ctx, node, m);
        }
    }
    if (!emittedNew) {
        if (fields.size === 0) out += `    pub fn new() -> Self { Self }\n`;
        else {
            const inits = [...fields.keys()].map(f => `${snake(f)}: Default::default()`);
            out += `    pub fn new() -> Self { Self { ${inits.join(", ")} } }\n`;
        }
    }
    out += "}\n";

    // trait impls
    for (const m of node.members) {
        if (!ts.isMethodDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) continue;
        const mn = m.name.text;
        if (mn === "Validate") {
            out += `\nimpl nest::Validatable for ${name} {\n    fn validate(&self) -> Result<(), nest::Error> {\n`;
            ctx.curRetIsResult = true;
            ctx.curRetIsVoidResult = true;
            out += emitMethodBody(ctx, m, true, true);
            ctx.curRetIsResult = false;
            ctx.curRetIsVoidResult = false;
            out += "    }\n}\n";
        }
        if (mn === "canActivate" || mn === "CanActivate") {
            out += `\nimpl nest::Guard for ${name} {\n    fn check(&self, ctx: &nest::Ctx) -> bool {\n`;
            out += emitMethodBody(ctx, m, false, false, "ctx");
            out += "    }\n}\n";
        }
        if (mn === "intercept") {
            out += `\nimpl nest::Interceptor for ${name} {\n    fn intercept(&self, ctx: &nest::Ctx) {\n`;
            out += emitMethodBody(ctx, m, false, false, "ctx");
            out += "    }\n}\n";
        }
    }
    return out;
}

function isRouteMethod(ctx: Ctx, cls: string, method: string): boolean {
    return (ctx.ctrlOf.get(cls)?.routes ?? []).some(r => ts.isIdentifier(r.method.name!) && r.method.name.text === method);
}

function emitCtor(ctx: Ctx, cls: ts.ClassDeclaration, m: ts.ConstructorDeclaration, fields: Map<string, { node?: ts.TypeNode; arc?: boolean }>): string {
    const paramProps = m.parameters.filter(p => (ts.getModifiers(p) ?? []).length > 0);
    const sig = m.parameters.map(p => `${snake(p.name.getText())}: std::sync::Arc<${emitType(ctx, p.type!, "param")}>`).join(", ");
    const assigns = new Map<string, ts.Expression>();
    for (const s of m.body?.statements ?? []) {
        if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) &&
            s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(s.expression.left) && s.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
            assigns.set(s.expression.left.name.text, s.expression.right);
        }
    }
    const inits: string[] = [];
    for (const [fname, f] of fields) {
        if (paramProps.some(p => ts.isIdentifier(p.name) && p.name.text === fname)) {
            inits.push(snake(fname));
            continue;
        }
        const prop = cls.members.find(x => ts.isPropertyDeclaration(x) && ts.isIdentifier(x.name!) && x.name.text === fname) as ts.PropertyDeclaration | undefined;
        const ftype = f.node ? emitType(ctx, f.node, "field") : "";
        if (assigns.has(fname)) {
            inits.push(`${snake(fname)}: ${emitExpr(ctx, assigns.get(fname)!, ftype)}`);
        } else if (prop?.initializer) {
            inits.push(`${snake(fname)}: ${emitExpr(ctx, prop.initializer, ftype)}`);
        } else {
            inits.push(`${snake(fname)}: Default::default()`);
        }
    }
    const body = `Self {\n${inits.map(i => "            " + i).join(",\n")}\n        }`;
    return `    pub fn new(${sig}) -> Self {\n        ${body}\n    }\n`;
}

function emitMethod(ctx: Ctx, cls: ts.ClassDeclaration, m: ts.MethodDeclaration): string {
    const ret = m.type ? emitType(ctx, m.type, "ret") : "()";
    const retSrc = m.type?.getText() ?? "";
    ctx.curRetIsResult = ret.startsWith("Result<");
    ctx.curRetFirstIsAny = retSrc.includes("Any");
    ctx.curRetIsVoidResult = /^\[(Void|Null)/.test(retSrc);
    ctx.curRetType = retSrc;
    const params = m.parameters.map(p => `${snake(p.name.getText())}: ${emitType(ctx, p.type!, "param")}`).join(", ");
    const needsMut = methodMutatesSelf(m);
    const sig = `&${needsMut ? "mut " : ""}self${params ? ", " + params : ""}`;
    const retDecl = ret === "()" ? "" : ` -> ${ret}`;
    collectMut(ctx, [...(m.body?.statements ?? [])]);
    let out = `    pub fn ${snake(m.name!.getText())}(${sig})${retDecl} {\n`;
    out += emitMethodBody(ctx, m, ctx.curRetIsResult, ctx.curRetFirstIsAny);
    out += "    }\n";
    ctx.curRetIsResult = ctx.curRetFirstIsAny = ctx.curRetIsVoidResult = false;
    ctx.curRetType = "";
    return out;
}

function methodMutatesSelf(m: ts.MethodDeclaration): boolean {
    let mut = false;
    const visit = (n: ts.Node) => {
        if (ts.isBinaryExpression(n) && ts.isPropertyAccessExpression(n.left) &&
            n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
            n.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
            if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind)) mut = true;
        }
        n.forEachChild(visit);
    };
    m.forEachChild(visit);
    return mut;
}

function collectMut(ctx: Ctx, stmts: ts.Node[]) {
    ctx.mut = new Set();
    ctx.guards = new Set();
    const visit = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
            if (n.initializer && ts.isCallExpression(n.initializer) &&
                ts.isPropertyAccessExpression(n.initializer.expression) && n.initializer.expression.name.text === "lock") {
                ctx.guards.add(n.name.text);
            }
        }
        if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) &&
            [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken].includes(n.operatorToken.kind)) {
            ctx.mut.add(n.left.text);
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
            const mn = n.expression.name.text;
            if (/^set/i.test(mn) || ["push", "insert", "iterMut", "register", "add", "remove", "clear", "extend", "reserve"].includes(mn)) {
                ctx.mut.add(n.expression.expression.text);
            }
        }
        n.forEachChild(visit);
    };
    for (const s of stmts) visit(s);
}

function emitMethodBody(ctx: Ctx, m: ts.MethodDeclaration, isResult: boolean, firstIsAny: boolean, ctxParamName?: string): string {
    const savedMut = ctx.mut, savedGuards = ctx.guards, savedRenames = ctx.renames;
    collectMut(ctx, [...(m.body?.statements ?? [])]);
    if (ctxParamName) {
        // trait impls name the param `ctx`; the source calls it something else
        const srcParam = m.parameters[0]?.name.getText();
        if (srcParam && srcParam !== "ctx") ctx.renames = new Map([[srcParam, "ctx"]]);
    }
    let out = "";
    for (const s of m.body?.statements ?? []) {
        out += indent(emitStmt(ctx, s));
    }
    ctx.mut = savedMut; ctx.guards = savedGuards; ctx.renames = savedRenames;
    return out;
}

// ---------- module factory codegen ----------

function emitModuleFactory(ctx: Ctx, node: ts.ClassDeclaration, sf: ts.SourceFile): string {
    const name = node.name!.text;
    const meta = ctx.moduleOf.get(name)!;
    let out = `pub fn new_${snake(name)}(deps: &mut nest::Deps) -> nest::Module {\n`;

    // providers: instantiate each with ctor deps resolved by type
    for (const p of meta.providers) {
        const ctorArgs = providerArgs(ctx, p, sf);
        out += `    let ${snake(p)} = std::sync::Arc::new(${pathForSymbol(ctx, p, ctx.classFile.get(p)!)}::new(${ctorArgs}));\n`;
        out += `    deps.register(${snake(p)}.clone());\n`;
    }

    // controllers
    const ctrlVars: string[] = [];
    for (const cn of meta.controllers) {
        const cm = ctx.ctrlOf.get(cn);
        const varName = snake(cn);
        const ctorArgs = providerArgs(ctx, cn, sf);
        out += `    let ${varName} = std::sync::Arc::new(${pathForSymbol(ctx, cn, ctx.classFile.get(cn)!)}::new(${ctorArgs}));\n`;
        let builder = `nest::Controller::new("${cm?.prefix ?? "/"}")`;
        for (const i of cm?.interceptors ?? []) builder += `\n        .interceptor(${pathForSymbol(ctx, i, ctx.classFile.get(i)!)}::new(${providerArgs(ctx, i, sf)}))`;
        for (const r of cm?.routes ?? []) {
            const mname = (r.method.name as ts.Identifier).text;
            const hasBody = r.method.parameters.length > 1;
            let handler = `        .${r.http}("${r.path}", { let c = ${varName}.clone(); std::sync::Arc::new(move |ctx: &mut nest::Ctx, b: serde_json::Value| -> Result<serde_json::Value, nest::Error> {\n`;
            if (hasBody) {
                const bt = emitType(ctx, r.method.parameters[1].type!, "general");
                handler += `            let b: ${bt} = serde_json::from_value(b).map_err(|e| nest::bad_request(e.to_string()))?;\n`;
                handler += `            nest::Validatable::validate(&b)?;\n`;
                handler += `            c.${snake(mname)}(ctx, b)\n        }) }`;
            } else {
                handler += `            c.${snake(mname)}(ctx)\n        }) }`;
            }
            if (r.guards.length) {
                const g = r.guards[0];
                builder += `\n${handler.replace("." + r.http, "." + r.http + "_g")}, nest::with_guard(${pathForSymbol(ctx, g, ctx.classFile.get(g)!)}::new(${providerArgs(ctx, g, sf)})))`;
            } else {
                builder += `\n${handler})`;
            }
        }
        out += `    let ${varName}_routes = ${builder};\n`;
        ctrlVars.push(varName);
    }

    let mchain = `nest::Module::new("${name}")`;
    for (const im of meta.imports) mchain += `\n        .import(${factoryPath(ctx, im)}(deps))`;
    for (const v of ctrlVars) mchain += `\n        .controller(${v}_routes)`;
    out += `    ${mchain}\n}\n`;
    return out;
}

// path to a module's factory fn: crate::core::CoreModule -> crate::core::new_core_module
function factoryPath(ctx: Ctx, className: string): string {
    const file = ctx.classFile.get(className);
    if (!file) return `new_${snake(className)}`;
    const typePath = pathForSymbol(ctx, className, file);
    const idx = typePath.lastIndexOf("::");
    const prefix = idx >= 0 ? typePath.slice(0, idx) : typePath;
    return `${prefix}::new_${snake(className)}`;
}

function providerArgs(ctx: Ctx, className: string, sf: ts.SourceFile): string {
    // resolve ctor params by type -> deps.get::<T>()
    for (const f of ctx.files) {
        for (const st of f.statements) {
            if (ts.isClassDeclaration(st) && st.name?.text === className) {
                const ctor = st.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
                if (!ctor) return "";
                return ctor.parameters.map(p => {
                    const t = p.type!.getText();
                    const target = ctx.classFile.get(t);
                    return `deps.get::<${pathForSymbol(ctx, t, target ?? sf.fileName)}>()`;
                }).join(", ");
            }
        }
    }
    return "";
}

// ---------- enum ----------

function emitEnum(ctx: Ctx, node: ts.EnumDeclaration): string {
    const name = node.name.text;
    const members = node.members.map(m => m.name.getText());
    return `#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]\npub enum ${name} {\n${members.map(m => "    " + m).join(",\n")}\n}\n`;
}

// ---------- functions ----------

function emitFn(ctx: Ctx, node: ts.FunctionDeclaration): string {
    const ret = node.type ? emitType(ctx, node.type, "ret") : "()";
    ctx.curRetIsResult = ret.startsWith("Result<");
    ctx.curRetFirstIsAny = (node.type?.getText() ?? "").includes("Any");
    ctx.curRetIsVoidResult = /^\[(Void|Null)/.test(node.type?.getText() ?? "");
    ctx.curRetType = node.type?.getText() ?? "";
    const params = node.parameters.map(p => `${snake(p.name.getText())}: ${emitType(ctx, p.type!, "param")}`).join(", ");
    collectMut(ctx, [...(node.body?.statements ?? [])]);
    let out = `pub fn ${snake(node.name!.text)}(${params})${ret === "()" ? "" : ` -> ${ret}`} {\n`;
    for (const s of node.body?.statements ?? []) out += indent(emitStmt(ctx, s));
    out += "}\n";
    ctx.curRetIsResult = ctx.curRetFirstIsAny = ctx.curRetIsVoidResult = false;
    return out;
}

// ---------- statements ----------

function emitStmt(ctx: Ctx, s: ts.Statement): string {
    if (ts.isVariableStatement(s)) {
        let out = "";
        for (const d of s.declarationList.declarations) {
            const isLet = (s.declarationList.flags & ts.NodeFlags.Let) !== 0 || true;
            if (ts.isArrayBindingPattern(d.name) || ts.isObjectBindingPattern(d.name)) {
                const names = bindingNames(d.name);
                if (ts.isObjectBindingPattern(d.name)) {
                    ctx.fail("object destructuring not supported in ruts — access fields directly", d);
                }
                if (d.initializer && ts.isCallExpression(d.initializer) && returnsResultTuple(ctx, d.initializer)) {
                    // Result<T, E> destructure -> match expansion
                    const rhs = emitExpr(ctx, d.initializer);
                    out += `let (${names.join(", ")}) = match ${rhs} { Ok(v) => (v, None), Err(e) => (Default::default(), Some(e)) };\n`;
                } else {
                    out += `let (${names.join(", ")}) = ${emitExpr(ctx, d.initializer!)};\n`;
                }
                continue;
            }
            const name = snake(d.name.getText());
            const mutKw = ctx.mut.has(d.name.getText()) || ctx.guards.has(d.name.getText()) ? "mut " : "";
            const ty = d.type ? `: ${emitType(ctx, d.type, "general")}` : "";
            const init = d.initializer ? ` = ${emitExpr(ctx, d.initializer, d.type?.getText())}` : "";
            out += `let ${mutKw}${name}${ty}${init};\n`;
        }
        return out;
    }
    if (ts.isReturnStatement(s)) {
        if (!s.expression) return "return;\n";
        if (ctx.curRetIsResult && ts.isArrayLiteralExpression(s.expression)) {
            const [a, b] = s.expression.elements;
            const exprTxt = (e: ts.Expression) => ts.isNonNullExpression(e) ? e.expression.getText() : e.getText();
            const aTxt = exprTxt(a), bTxt = exprTxt(b);
            if (ctx.curRetIsVoidResult) {
                if (bTxt === "null") return "return Ok(());\n";
                return `return Err(${unwrapErr(ctx, b)});\n`;
            }
            if (aTxt === "null" && bTxt === "null") return `return Ok(${ctx.curRetFirstIsAny ? "serde_json::Value::Null" : "Default::default()"});\n`;
            if (aTxt === "null") return `return Err(${unwrapErr(ctx, b)});\n`;
            if (bTxt === "null") return `return Ok(${ctx.curRetFirstIsAny ? toValue(ctx, a) : emitExpr(ctx, a)});\n`;
            return `return Ok((${emitExpr(ctx, a)}, ${emitExpr(ctx, b)}));\n`;
        }
        return `return ${emitExpr(ctx, s.expression, ctx.curRetType)};\n`;
    }
    if (ts.isThrowStatement(s)) return `panic!(\"{}\", ${emitExpr(ctx, s.expression)});\n`;
    if (ts.isIfStatement(s)) {
        let out = `if ${emitExpr(ctx, s.expression)} {\n`;
        out += indent(emitBlockish(ctx, s.thenStatement));
        if (s.elseStatement) {
            out += `    } else `;
            if (ts.isIfStatement(s.elseStatement)) {
                out += emitStmt(ctx, s.elseStatement).replace(/^if /, "if ").trimStart();
                return "    " + out.trimStart();
            }
            out += `{\n${indent(emitBlockish(ctx, s.elseStatement))}    }\n`;
        } else out += "    }\n";
        return out;
    }
    if (ts.isForOfStatement(s)) {
        const varName = ts.isVariableDeclarationList(s.initializer) ? snake(s.initializer.declarations[0].name.getText()) : "_";
        const itT = ctx.checker.typeToString(ctx.checker.getTypeAtLocation(s.expression));
        const iter = itT.startsWith("Channel") ? `${emitExpr(ctx, s.expression)}.rx.iter()` : emitExpr(ctx, s.expression);
        return `for ${varName} in ${iter} {\n${indent(emitBlockish(ctx, s.statement))}    }\n`;
    }
    if (ts.isForStatement(s)) {
        // translate for(init;cond;incr) to while
        const init = s.initializer ? (ts.isVariableDeclarationList(s.initializer) ? emitStmt(ctx, ts.factory.createVariableStatement(undefined, s.initializer)) : emitExprStmt(ctx, s.initializer)) : "";
        const cond = s.condition ? emitExpr(ctx, s.condition) : "true";
        const incr = s.incrementor ? emitExprStmt(ctx, s.incrementor) : "";
        return `${init}while ${cond} {\n${indent(emitBlockish(ctx, s.statement) + incr)}    }\n`;
    }
    if (ts.isWhileStatement(s)) {
        return `while ${emitExpr(ctx, s.expression)} {\n${indent(emitBlockish(ctx, s.statement))}    }\n`;
    }
    if (ts.isBlock(s)) {
        return `{\n${indent(s.statements.map(x => emitStmt(ctx, x)).join(""))}    }\n`;
    }
    if (ts.isTryStatement(s)) {
        // try { A } finally { B } -> { A; B }
        let out = "{\n";
        out += indent((s.tryBlock.statements.map(x => emitStmt(ctx, x))).join(""));
        if (s.finallyBlock) out += indent(s.finallyBlock.statements.map(x => emitStmt(ctx, x)).join(""));
        out += "    }\n";
        return out;
    }
    if (ts.isExpressionStatement(s)) return emitExprStmt(ctx, s.expression);
    if (ts.isBreakStatement(s)) return "break;\n";
    if (ts.isContinueStatement(s)) return "continue;\n";
    return `// ruts: skipped ${ts.SyntaxKind[s.kind]}\n`;
}

function emitBlockish(ctx: Ctx, s: ts.Statement): string {
    if (ts.isBlock(s)) return s.statements.map(x => emitStmt(ctx, x)).join("");
    return emitStmt(ctx, s);
}

function emitExprStmt(ctx: Ctx, e: ts.Expression): string {
    return emitExpr(ctx, e) + ";\n";
}

function bindingNames(p: ts.BindingPattern): string[] {
    return p.elements.map(e => ts.isBindingElement(e) ? snake(e.name.getText()) : "_");
}

// true when the callee's declared return type is `[X, Error]` — a Result in Rust
function returnsResultTuple(ctx: Ctx, call: ts.CallExpression): boolean {
    let retTxt = "";
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
        const sym = ctx.checker.getSymbolAtLocation(callee.name);
        const decl = sym?.declarations?.[0];
        if (decl && ts.isMethodDeclaration(decl) && decl.type) retTxt = decl.type.getText();
    } else if (ts.isIdentifier(callee)) {
        const sym = ctx.checker.getSymbolAtLocation(callee);
        const decl = sym?.declarations?.[0];
        if (decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) && decl.type) retTxt = decl.type.getText();
    }
    return /^\[.+,\s*Error(\s*\|\s*null)?\]$/.test(retTxt.replace(/\s+/g, " "));
}

function unwrapErr(ctx: Ctx, e: ts.Expression): string {
    // e may be Option<Error> (union with null) or plain Error
    // use the type at the declaration site — flow narrowing at the use site drops the null
    const sym = ctx.checker.getSymbolAtLocation(e);
    const declName = sym?.declarations?.[0] && ts.isBindingElement(sym.declarations[0])
        ? sym.declarations[0].name
        : sym?.declarations?.[0];
    const t = declName ? ctx.checker.getTypeAtLocation(declName) : ctx.checker.getTypeAtLocation(e);
    if (t.isUnion() && t.types.some(x => (x.flags & ts.TypeFlags.Null) !== 0)) {
        return `${emitExpr(ctx, e)}.unwrap()`;
    }
    return emitExpr(ctx, e);
}

function toValue(ctx: Ctx, e: ts.Expression): string {
    const inner = emitExpr(ctx, e);
    const t = ctx.checker.getTypeAtLocation(e);
    const tt = ctx.checker.typeToString(t);
    if (tt === "any" || tt === "Any") return inner;
    return `serde_json::to_value(${inner}).unwrap()`;
}

// ---------- expressions ----------

function emitExpr(ctx: Ctx, e: ts.Expression, want?: string): string {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        const wantsString = want === "Str" || want === "string";
        return wantsString ? `${JSON.stringify(e.text)}.to_string()` : JSON.stringify(e.text);
    }
    if (ts.isNumericLiteral(e)) return e.text;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (e.kind === ts.SyntaxKind.NullKeyword) return "None";
    if (e.kind === ts.SyntaxKind.ThisKeyword) return "self";
    if (ts.isIdentifier(e)) return emitIdent(ctx, e);
    if (ts.isParenthesizedExpression(e)) return `(${emitExpr(ctx, e.expression, want)})`;
    if (ts.isTemplateExpression(e)) {
        // `a${x}b` -> format!("a{}b", x)
        let fmt = e.head.text;
        const args: string[] = [];
        for (const span of e.templateSpans) {
            fmt += "{}" + span.literal.text;
            args.push(emitExpr(ctx, span.expression));
        }
        return `format!(${JSON.stringify(fmt)}${args.length ? ", " + args.join(", ") : ""})`;
    }
    if (ts.isArrayLiteralExpression(e)) {
        return `vec![${e.elements.map(x => emitExpr(ctx, x)).join(", ")}]`;
    }
    if (ts.isObjectLiteralExpression(e)) {
        // struct literal when contextual type is known (want=type name)
        const props = e.properties.map(p => {
            if (ts.isPropertyAssignment(p)) {
                const key = snake(p.name.getText());
                const val = emitExpr(ctx, p.initializer, "Str");
                return `${key}: ${val}`;
            }
            if (ts.isShorthandPropertyAssignment(p)) return snake(p.name.text);
            return "";
        }).filter(Boolean);
        const wantLast = want ? want.split("::").pop()!.split("|")[0].trim() : "";
        const typeName = wantLast && /^[A-Z]/.test(wantLast) ? want : "";
        if (typeName) return `${typeName} { ${props.join(", ")}, ..Default::default() }`;
        return `serde_json::json!({ ${e.properties.map(p => {
            if (ts.isPropertyAssignment(p)) return `"${p.name.getText()}": ${emitExpr(ctx, p.initializer)}`;
            return "";
        }).join(", ")} })`;
    }
    if (ts.isNewExpression(e)) {
        const name = e.expression.getText();
        const argList = [...(e.arguments ?? [])];
        if (name === "Mutex") {
            // thread the Vec element type into object literals: Mutex<Vec<T>> seed
            const mm = want?.match(/Mutex<Vec<(.+)>>/);
            if (argList[0] && ts.isArrayLiteralExpression(argList[0]) && mm) {
                return `std::sync::Mutex::new(vec![${argList[0].elements.map(x => emitExpr(ctx, x, mm![1])).join(", ")}])`;
            }
            return `std::sync::Mutex::new(${argList.map(a => emitExpr(ctx, a, want && /Mutex<(.+)>/.test(want) ? want.match(/Mutex<(.+)>/)![1] : undefined)).join(", ")})`;
        }
        if (name === "Channel") return `nest::chan()`;
        if (name.startsWith("Array")) return "Vec::new()";
        const args = argList.map(a => emitExpr(ctx, a));
        return `${resolveTypePath(ctx, name)}::new(${args.join(", ")})`;
    }
    if (ts.isCallExpression(e)) return emitCall(ctx, e, want);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        const params = e.parameters.map(p => snake(p.name.getText())).join(", ");
        if (ts.isBlock(e.body)) {
            const body = e.body.statements.map(s => emitStmt(ctx, s)).join("");
            return `move |${params}| {\n${indent(body)}}`;
        }
        return `move |${params}| ${emitExpr(ctx, e.body)}`;
    }
    if (ts.isPropertyAccessExpression(e)) {
        const lhs = emitRef(ctx, e.expression);
        const name = e.name.text;
        if (name === "length") return `${lhs}.len()`;
        if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
            return `self.${snake(name)}`;
        }
        // module.X stays PascalCase? type refs keep case; field access -> snake
        const lt = ctx.checker.getTypeAtLocation(e.expression);
        const lts = ctx.checker.typeToString(lt);
        if (/^[a-z]/.test(e.expression.getText()) || e.expression.getText() === "dto" || lts.includes("Dto") || lts.includes("User")) {
            return `${lhs}.${snake(name)}`;
        }
        return `${lhs}.${name}`;
    }
    if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken) {
            return `${emitLhs(ctx, e.left)} = ${emitExpr(ctx, e.right, want)}`;
        }
        if (op === ts.SyntaxKind.PlusEqualsToken) return `${emitLhs(ctx, e.left)} += ${emitExpr(ctx, e.right)}`;
        if (op === ts.SyntaxKind.MinusEqualsToken) return `${emitLhs(ctx, e.left)} -= ${emitExpr(ctx, e.right)}`;
        if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
            if (e.right.getText() === "null") return `${emitExpr(ctx, e.left)}.is_none()`;
            if (e.left.getText() === "null") return `${emitExpr(ctx, e.right)}.is_none()`;
            return `${emitExpr(ctx, e.left)} == ${emitExpr(ctx, e.right)}`;
        }
        if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            if (e.right.getText() === "null") return `${emitExpr(ctx, e.left)}.is_some()`;
            if (e.left.getText() === "null") return `${emitExpr(ctx, e.right)}.is_some()`;
            return `${emitExpr(ctx, e.left)} != ${emitExpr(ctx, e.right)}`;
        }
        const ops: Record<number, string> = {
            [ts.SyntaxKind.PlusToken]: "+", [ts.SyntaxKind.MinusToken]: "-",
            [ts.SyntaxKind.AsteriskToken]: "*", [ts.SyntaxKind.SlashToken]: "/",
            [ts.SyntaxKind.PercentToken]: "%", [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
            [ts.SyntaxKind.BarBarToken]: "||", [ts.SyntaxKind.LessThanToken]: "<",
            [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
            [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
        };
        if (ops[op]) {
            // `str + x` in Rust: format! is safer for string concat
            if (op === ts.SyntaxKind.PlusToken && (looksString(ctx, e.left) || looksString(ctx, e.right))) {
                return `format!("{}{}", ${emitExpr(ctx, e.left)}, ${emitExpr(ctx, e.right)})`;
            }
            return `${emitExpr(ctx, e.left)} ${ops[op]} ${emitExpr(ctx, e.right)}`;
        }
    }
    if (ts.isPrefixUnaryExpression(e)) {
        if (e.operator === ts.SyntaxKind.ExclamationToken) return `!${emitExpr(ctx, e.operand)}`;
        if (e.operator === ts.SyntaxKind.MinusToken) return `-${emitExpr(ctx, e.operand)}`;
    }
    if (ts.isPostfixUnaryExpression(e)) {
        if (e.operator === ts.SyntaxKind.PlusPlusToken) return `${emitExpr(ctx, e.operand)} += 1`;
        if (e.operator === ts.SyntaxKind.MinusMinusToken) return `${emitExpr(ctx, e.operand)} -= 1`;
    }
    if (ts.isConditionalExpression(e)) {
        return `if ${emitExpr(ctx, e.condition)} { ${emitExpr(ctx, e.whenTrue)} } else { ${emitExpr(ctx, e.whenFalse)} }`;
    }
    if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) {
        const t = e.type.getText();
        const casts: Record<string, string> = {
            Int32: "i32", Int: "i32", Int64: "i64", Float32: "f32", Float64: "f64",
            Usize: "usize", Bool: "bool",
        };
        if (casts[t]) return `${emitExpr(ctx, e.expression)} as ${casts[t]}`;
        return emitExpr(ctx, e.expression, want);
    }
    if (ts.isNonNullExpression(e)) return emitExpr(ctx, e.expression, want);
    ctx.fail(`unsupported expression '${e.getText().slice(0, 40)}' (${ts.SyntaxKind[e.kind]})`, e);
    return "";
}

function emitLhs(ctx: Ctx, e: ts.Expression): string {
    if (ts.isIdentifier(e) && ctx.guards.has(e.text)) return `*${snake(e.text)}`;
    return emitExpr(ctx, e);
}

function looksString(ctx: Ctx, e: ts.Expression): boolean {
    if (ts.isStringLiteral(e) || ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    const t = ctx.checker.getTypeAtLocation(e);
    const s = ctx.checker.typeToString(t);
    return s === "string" || s === "Str";
}

function emitIdent(ctx: Ctx, e: ts.Identifier): string {
    const name = ctx.renames.get(e.text) ?? e.text;
    if (ctx.guards.has(e.text)) return `*${snake(name)}`;
    if (/^[A-Z]/.test(name)) return name;
    return snake(name);
}

// receiver position: guard vars emit their name (method calls deref through the guard)
function emitRef(ctx: Ctx, e: ts.Expression): string {
    if (ts.isIdentifier(e) && ctx.guards.has(e.text)) return snake(e.text);
    return emitExpr(ctx, e);
}

function emitCall(ctx: Ctx, e: ts.CallExpression, want?: string): string {
    const callee = e.expression;
    const args = e.arguments.map(a => emitExpr(ctx, a));

    if (ts.isIdentifier(callee)) {
        const n = callee.text;
        const casts: Record<string, string> = {
            Int32: "i32", Int: "i32", Int64: "i64", Float32: "f32", Float64: "f64", Usize: "usize",
        };
        if (casts[n]) return `${args[0]} as ${casts[n]}`;
        if (n === "parseInt") return `${args[0]}.parse::<i32>().unwrap_or(0)`;
        if (n === "spawn" || n === "go") return `std::thread::spawn(${args.join(", ")})`;
        if (/^[A-Z]/.test(n) && args.length) return `${resolveTypePath(ctx, n)}::from(${args.join(", ")})`;
        return `${snake(n)}(${args.join(", ")})`;
    }
    if (ts.isPropertyAccessExpression(callee)) {
        const objTxt = callee.expression.getText();
        const m = callee.name.text;
        const obj = emitRef(ctx, callee.expression);

        if (objTxt === ctx.nestAlias || objTxt === "nest") {
            if (m === "Create") {
                const modArg = e.arguments[0]?.getText() ?? "";
                return `nest::create({ let mut d = nest::Deps::new(); ${factoryPath(ctx, modArg)}(&mut d) })`;
            }
            if (EXC[m]) return `nest::${EXC[m]}(${args.join(", ")})`;
            return `nest::${snake(m)}(${args.join(", ")})`;
        }
        if (objTxt === "console" && m === "log") {
            const fmt = args.map(() => "{}").join(" ");
            return `println!("${fmt}"${args.length ? ", " + args.join(", ") : ""})`;
        }
        if (m === "lock") return `${obj}.lock().unwrap()`;
        if (m === "get" && ctx.guards.has(objTxt)) return `*${snake(objTxt)}`;
        if (m === "set" && ctx.guards.has(objTxt)) return `*${snake(objTxt)} = ${args[0]}`;
        if (m === "iterMut") return `${obj}.iter_mut()`;
        if (m === "iter") return `${obj}.iter()`;
        if (m === "push") return `${obj}.push(${args.join(", ")})`;
        if (m === "emit") return `${obj}.send(${args.join(", ")}).unwrap()`;
        if (m === "recv") return `${obj}.recv().unwrap()`;
        if (m === "close") {
            const t = ctx.checker.typeToString(ctx.checker.getTypeAtLocation(callee.expression));
            return t.startsWith("Channel") ? `drop(${obj}.tx)` : `drop(${obj})`;
        }
        if (m === "cloneTx") return `${obj}.tx.clone()`;
        // method on this/field -> snake_case
        const lhs = callee.expression.kind === ts.SyntaxKind.ThisKeyword ? "self" : obj;
        return `${lhs}.${snake(m)}(${args.join(", ")})`;
    }
    return `${emitExpr(ctx, callee)}(${args.join(", ")})`;
}

// ---------- diagnostics entry for CLI ----------

export function diagnostics(rootDir: string): ts.Diagnostic[] {
    const files = collectTs(rootDir);
    const program = ts.createProgram([...files, ...ambientTypes(rootDir)], {
        strict: false, strictNullChecks: true, experimentalDecorators: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS, noEmit: true, skipLibCheck: true,
    });
    const out = [...ts.getPreEmitDiagnostics(program)];
    for (const f of files) {
        const sf = program.getSourceFile(f);
        if (sf) out.push(...allDiagnostics(sf));
    }
    return out;
}
