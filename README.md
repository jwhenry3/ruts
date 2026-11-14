# RUSTS — write NestJS apps in TypeScript syntax, ship them as native Rust

**rusts** is a TypeScript-flavored language that transpiles to plain, idiomatic
Rust — and **nestrs** is a real NestJS-style application written in rusts,
running on a hand-written `nest` framework crate.

Write modules, dependency injection, controllers, DTOs, guards, interceptors,
and views in `.ts` files — compile to ordinary `.rs` and `cargo build`/`run`
it like normal Rust. No runtime shim: decorators are compile-time wiring that
disappears entirely.

```ts
@Controller("/users")
export class UserController {
    constructor(private users: UsersService) {}

    @Get("/{id}")
    findOne(c: Ptr<nest.Ctx>): [Any, Error | null] {
        const [id, err] = c.ParamInt("id");
        if (err !== null) return [null!, err];
        const [u, e2] = this.users.findOne(id);
        if (e2 !== null) return [null!, e2];
        return [u, null];
    }
}
```

```rust
// generated — dependency-light, readable Rust
pub fn find_one(&self, c: &mut nest::Ctx) -> Result<serde_json::Value, nest::Error> {
    let (id, err) = c.param_int("id");
    if err.is_some() { return Err(err.unwrap()); }
    let (u, e2) = match self.users.find_one(id) {
        Ok(v) => (v, None), Err(e) => (Default::default(), Some(e)) };
    if e2.is_some() { return Err(e2.unwrap()); }
    return Ok(serde_json::to_value(u).unwrap());
}
```

## Quick start

Prereqs: Rust toolchain (`cargo`/`rustc`), a Node new enough to run `.ts`
files directly (Node 22.6+ / 24), and `npm install` inside `rusts/`.

```bash
cd rusts && npm install && cd ..
npm run dev        # transpile nestrs/src -> .rs, then cargo run (PORT, default :3000)
```

Then:

```
GET    /api              -> renders views/index.html
GET    /api/users        -> all users
GET    /api/users/{id}   -> one user
POST   /api/users        -> create (validates name/email)
PATCH  /api/users/{id}   -> update
DELETE /api/users/{id}   -> guarded: requires header x-api-key: secret
```

## The 60-second language tour

Type annotations **are** Rust types:

```ts
let n: Int32 = 3 as Int32;         // i32    — branded, nominally distinct
let f: Float64 = 1.5;              // f64
let s: Str = "hi";                 // String
let ok: Bool = true;               // bool
let xs: Int32[] = [1, 2];          // Vec<i32>
let m = new Mutex<Int32>(Int32(0));   // std::sync::Mutex<i32>
let ch = new Channel<Int32>();     // std::sync::mpsc — ch.tx / ch.rx
```

Rust conventions map to familiar syntax:

```ts
[T, Error]            -> Result<T, nest::Error>       (return [v, null] -> Ok(v))
[T, Error | null]     -> Result<T, nest::Error>       (same — null marks the Err slot)
[T, Ptr<Error>|null]  -> (T, Option<Error>)           (real tuple — framework internals)
T | null              -> Option<T>
throw e               -> panic!("{}", e)
arr.push(x)           -> arr.push(x)
x.length              -> x.len()
`a ${b} c`            -> format!("a {} c", b)
x.clone()             -> x.clone()          — every struct derives Clone
spawn(() => {...})    -> std::thread::spawn(move || {...})
for (const v of ch)   -> for v in ch.rx.iter()
```

## IDE setup

The `.ts` files are real TypeScript to your editor — the flavor comes from
two ambient declaration files plus a tsserver plugin that adds
rusts-specific diagnostics live.

1. **Ambient types** (`rusts/types/rusts.d.ts`, `nestrs/types/nest.d.ts`)
   declare `Int32`, `Ptr<T>`, `Mutex<T>`, `Channel<T>`, the `nest` module,
   and all decorators — no imports needed for decorators.
2. **tsserver plugin** (`nestrs/plugin`, referenced by
   `nestrs/tsconfig.json`) surfaces rusts-only checks — e.g.
   `let x: Int32 = 1.5` (TS95001) and unsupported constructs (TS95002)
   with `rusts:` messages — as live squiggles.
   If squiggles don't appear: restart the TS Server
   (VS Code: `Ctrl+Shift+P` -> "TypeScript: Restart TS Server").

## Layout

```
rusts/                  the transpiler
├── src/emitter.ts      TS AST -> Rust emitter (all the logic)
├── src/cli.ts          rusts build|check|run <dir>
├── src/checks.cjs      shared rusts-only diagnostics
├── plugin/             tsserver plugin
├── types/rusts.d.ts    ambient Rust types
└── examples/           hello.ts / concurrency.ts

nestrs/                 the app + framework (cargo workspace)
├── nest/               framework crate — hand-written Rust, NOT generated
├── types/nest.d.ts     framework API + decorator declarations
├── views/index.html    view template
├── plugin/             tsserver plugin copy for this project
└── src/                rusts sources — FOLDERS ARE RUST MODULES
    ├── main.ts             crate root — bootstrap
    ├── app.module.ts       @Module root
    ├── app.controller.ts   @Controller("/") — renders the view
    ├── core/               mod core — ConfigService provider
    └── users/              mod users — controller/service/guards/module
        └── dto/            mod dto — Create/UpdateUserDto + Validate()
```

Generated `.rs` files are gitignored — `npm run build:ts` regenerates.

## Verify

```bash
npm run verify     # typecheck transpiler + examples + transpile app + cargo build
npm run check      # rusts check nestrs/src — TS + rusts diagnostics, no emit
npm run clean      # delete generated .rs siblings of .ts files
```

See `AGENTS.md` for the detailed mental model and `docs/` for the language
and framework references.
