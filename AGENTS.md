# rs-nest — agent memory

## What this repo is

A TypeScript-flavored language (**rusts**) that compiles to plain Rust, plus
**nestrs** — a real NestJS-style application written in rusts on top of a
hand-written `nest` framework crate. Sister project of `~/go-nest` (gots→Go);
same architecture, Rust semantics.

The goal: write NestJS-shaped code (modules, DI, controllers, DTOs, guards,
interceptors, views) in `.ts` files, transpile to idiomatic `.rs`, and
`cargo build`/`run` it like normal Rust.

## Layout

```
rusts/                   the transpiler (ESM, "type": "module")
├── src/emitter.ts       TS AST -> Rust emitter (all logic lives here)
├── src/cli.ts           rusts build|check|run <dir>
├── src/checks.cjs       shared rusts-only diagnostics (CJS — tsserver requires it)
├── plugin/              tsserver plugin — injects those diagnostics in the IDE
├── types/rusts.d.ts     ambient Rust types: Int32, Ptr<T>, Mutex, Channel...
└── examples/            hello.ts / concurrency.ts (+ generated .rs — gitignored)

nestrs/                  the app + framework (cargo workspace)
├── nest/                framework crate — hand-written Rust, NOT generated
│   └── src/lib.rs       router, Ctx, DI (Deps), Module/Controller builders,
│                        guards/interceptors/filters, exceptions, views, Chan
├── types/nest.d.ts      framework API + decorator declarations
├── views/index.html     view template
├── plugin/              self-contained tsserver plugin copy (index.cjs + checks.cjs)
└── src/                 rusts sources — FOLDERS ARE RUST MODULES
    ├── main.ts              crate root — pub mod + pub use + fn main
    ├── app.module.ts        @Module root — imports CoreModule + UsersModule
    ├── app.controller.ts    @Controller("/") — renders the view
    ├── core/                mod core — ConfigService provider
    └── users/               mod users — controller/service/guards/module
        └── dto/             mod dto — Create/UpdateUserDto + Validate()
```

## Commands

```bash
# preferred — root package.json scripts (run from repo root)
npm run dev          # transpile nestrs/src + cargo run (PORT env, default :3000)
npm run build        # transpile + cargo build --manifest-path nestrs/Cargo.toml
npm run verify       # typecheck + examples + build — the full pipeline
npm run check        # rusts check nestrs/src (TS + rusts diagnostics)
npm run examples     # transpile rusts/examples
npm run clean        # delete generated .rs that have .ts siblings (keeps nestrs/nest)

# direct
node rusts/src/cli.ts build nestrs/src     # recursive — writes .rs next to .ts
node rusts/src/cli.ts check nestrs/src     # diagnostics only
cd nestrs && cargo build                   # framework + generated code

# typecheck the transpiler's own sources
cd rusts && npx tsc -p tsconfig.json
```

Gotcha: generated `.rs` files are **gitignored** — always rebuild after
checkout: `node rusts/src/cli.ts build nestrs/src`.

## rusts rules (the important ones)

- Type annotations ARE Rust types: `Int32`, `Int64`, `Float64`, `Usize`,
  `Bool`, `Str`, `Ptr<T>`, `Mutex<T>`, `Channel<T>`, `T[]`.
- PascalCase numerics are **branded** (`number & {__rusts:"i32"}`) — nominally
  distinct. Literals need `as Int32` or the `Int32(x)` conversion (emits `x as i32`).
- **Multi-return = Result**: `[T, Error]` or `[T, Error | null]` →
  `Result<T, nest::Error>`; `return [v, null]` → `Ok(v)`;
  `return [null, e]` / `[null!, e]` → `Err(e)` (auto `.unwrap()` for Option<e>).
  `[T, Ptr<Error> | null]` → real tuple `(T, Option<Error>)` — framework
  internals only (`Ctx.ParamInt`, `Ctx.Render`, `Ctx.JSON`).
- `[Null, Error | null]` (or `[Void, ...]`) → `Result<(), Error>` — Validate().
- `T | null` → `Option<T>`; any other union → diagnostic (Rust has enums).
- `const [a, e] = f()` where `f: [T, Error|..]` → `let (a, e) = match f() {...}`
  expansion; `if (e !== null)` → `e.is_some()`; `=== null` → `is_none()`.
- `null!` — non-null-asserted null: satisfies `strictNullChecks` in the value
  slot when returning `[null!, err]` (emits `Err`, text-matched after stripping `!`).
- `throw e` → `panic!`; `x?.y` not ported; `Mutex<T>` → `std::sync::Mutex`,
  `.lock()` → `.lock().unwrap()`, guard `.get()/.set(v)` → `*g`/`*g = v`,
  guard `.push/.iterMut/.remove(i)` → Vec methods through the guard.
- `Channel<T>` → `nest::Chan<T>` (`std::sync::mpsc` both ends):
  `.emit(v)` → `.tx.send`, `.recv()` → `.rx.recv()`, `for (const v of ch)` →
  `for v in ch.rx.iter()`, `.cloneTx()` → `.tx.clone()` (a `ChanSender`),
  `.close()` → `drop(ch.tx)` on Chan / `drop(tx)` on ChanSender.
- `spawn(f)`/`go(f)` → `std::thread::spawn`; arrow fns → `move |args| {...}`.
- `interface` all-fields → `#[derive] pub struct`; `class` → `pub struct` +
  `impl` + `new()`; `constructor(private x: T)` → `Arc<T>` field + DI wiring.
- Members are `pub` on DTO/interface-derived structs; method names snake_case;
  fields snake_case.

## Decorators (compile-time, erased)

`@Module({imports,controllers,providers,exports})` → `pub fn new_x(deps: &mut
nest::Deps) -> nest::Module` with wiring inlined. `@Controller("/users")` +
`@Get/@Post/@Patch/@Delete(path)` → `nest::Controller::new(p).get|post|...(
path, Arc::new(move |ctx, body| c.method(ctx[, body])))`. `@Injectable()` →
`new()` for DI (`deps.get::<T>()`). `@UseGuards`/`@UseInterceptors` →
`.interceptor(...)` on the controller or `method_g(path, h,
nest::with_guard(G))` route variant. `@Module` class as a value
(`nest.Create(AppModule)`) → `new_app_module(&mut deps)`.

Decorators are ambient globals (declared in `nestrs/types/nest.d.ts`).

## Multi-module rules

- Each source DIRECTORY is a Rust module; build-root dir = crate root.
- Root `main.ts` emits `pub mod x; pub use x::*;` for sibling files + subdir
  modules (skips siblings that are themselves main-like).
- `import {X} from "./same-dir"` → stripped (same module).
- `import {X} from "./sub"` → `crate::sub::X`; `from "../other"` → `crate::other::X`
  (`crate::` at root, `super::` in subdirs).
- `use` is emitted for named imports; `@Module` classes import as their
  `new_x` factory instead.
- `import * as nest from "nest"` binds the framework — REQUIRED form
  (default import errors with TS1192 and leaves `nest.Ctx` as `any`).

## Framework API (nestrs/nest)

`nest::create(mod)`, `app.set_global_prefix`, `set_views`, `listen`,
`Deps::register/get`. `Ctx`: `param`, `param_int` → `(i32, Option<Error>)`,
`query`, `header`, `status`, `json`, `render`, `body`. `with_guard` /
`with_interceptor` route opts. Exceptions: `bad_request`, `unauthorized`,
`forbidden`, `not_found`, `conflict`, `internal` (+ `nest::Error` struct).
`env_or`. DTO validation: `impl nest::Validatable for X { fn validate }` —
called on body injection. `nest::Chan<T>`/`chan()` for mpsc.

## Gotchas / known limitations

- `createProgram` uses hardcoded options — `strictNullChecks: true` is ON
  (null unions must stay visible). The app tsconfig matches.
- Ambient `.d.ts` files are loaded via `ambientTypes(rootDir)` — rusts' own
  `types/` + `<rootDir>/../types/` — NOT via tsconfig `include`.
- `Int64(1.5)` errors (diag 95001); unsupported constructs = 95002 (`rusts:`),
  `checks.cjs` `unsupportedDiagnostics()` mirrors emitter `fail()` — keep in sync.
- `getTypeOfSymbolAtLocation` is flow-NARROWED — `unwrapErr` checks the type
  at the *declaration site* (`sym.declarations[0].name`) to see `T | null`.
- Object destructuring is a diagnostic (no Rust equivalent); array
  destructuring works for Result/tuple returns.
- `isNullableUnion` in checks.cjs = "exactly one non-null member" — gots'
  version has a latent bug (required ALL members nullish); don't copy it back.
- `nest.Ctx` params are declared `Ptr<nest.Ctx>` → `&mut nest::Ctx`; trait
  impls rename the param to `ctx` via `ctx.renames`.
- `nestrs/plugin/` is a self-contained copy (checks.cjs + index.cjs) — keep
  in sync with `rusts/src/checks.cjs`.
- `cargo --manifest-path` is NOT a global flag — it's
  `cargo build --manifest-path` (subcommand flag).

## Verification checklist after emitter changes

1. `node rusts/src/cli.ts build rusts/examples` — both examples emit; compile
   them with rustc `-L nestrs/target/debug/deps --extern serde/nest/...`.
2. `node rusts/src/cli.ts check nestrs/src` — zero diagnostics.
3. `cd nestrs && cargo build` — clean.
4. `PORT=3210 cargo run` then curl: `/api` (view), `/api/users` CRUD,
   `DELETE` 401 without `x-api-key: secret`, 200 with.
