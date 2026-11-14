# ruts — language reference

ruts is a TypeScript-flavored syntax that emits plain Rust. Type annotations
are Rust types verbatim; the emitter translates syntax, it doesn't add a
runtime. Anything TS-legal that has no Rust mapping is a compile-time
diagnostic (code `95002`, `ruts:` prefix) — never silently broken output.

## Type mappings

| ruts type | Rust type |
|---|---|
| `Int32`, `Int` | `i32` |
| `Int64` | `i64` |
| `Float32`, `Float64` | `f32`, `f64` |
| `Usize` | `usize` |
| `Bool` | `bool` |
| `Str` (params) | `&str` |
| `Str` (fields/returns) | `String` |
| `Void` / `Null` | `()` |
| `Any` | `serde_json::Value` |
| `Ptr<T>` | `&T` in params (`&mut` for Ctx), `T` elsewhere |
| `Mutex<T>` | `std::sync::Mutex<T>` |
| `Channel<T>` | `nest::Chan<T>` (mpsc tx+rx) |
| `ChanSender<T>` | `std::sync::mpsc::Sender<T>` |
| `T[]` | `Vec<T>` |
| `[T, Error]` / `[T, Error \| null]` | `Result<T, nest::Error>` |
| `[T, Ptr<Error> \| null]` | `(T, Option<nest::Error>)` — real tuple |
| `[Null, Error \| null]` | `Result<(), nest::Error>` |
| `T \| null` | `Option<T>` |
| class / interface | `pub struct` (+ `impl`, `new()`) |

PascalCase numerics are branded (`number & {__ruts:"i32"}`) so `Int32` and
`Float64` are nominally distinct — like Rust itself. Brand-to-brand casts
don't work; use conversion calls: `Int32(x)` → `x as i32`, `Usize(x)` →
`x as usize`. Literals: `3 as Int32` (erased-ish `as`) or `Int32(3)`.

## Multi-return convention (Result)

```ts
findOne(id: Int32): [User, Error | null] {
    ...
    if (u) return [u, null];                       // Ok(u)
    return [null!, nest.NotFoundException("no")];  // Err(...)
}
```

- `return [v, null]` → `return Ok(v)` (v wrapped via `serde_json::to_value`
  when the declared first slot is `Any`).
- `return [null, e]` / `[null!, e]` → `return Err(e)` — `e` auto-unwraps
  when its declared type is `Option<Error>`.
- Destructure: `const [u, e] = svc.findOne(id)` →
  `let (u, e) = match svc.find_one(id) { Ok(v)=>(v,None), Err(e)=>(Default::default(),Some(e)) };`
- `e !== null` → `e.is_some()`; `e === null` → `e.is_none()`.
- `[T, Ptr<Error> | null]` is the real-tuple escape hatch used by framework
  internals (`Ctx.ParamInt` → `(i32, Option<Error>)`).

## Syntax mapping

| ruts | Rust |
|---|---|
| `interface` all-fields | `#[derive(Clone,Debug,Default,Serialize,Deserialize)] pub struct` |
| `class` | `pub struct` + `impl` + `new()` |
| `constructor(private x: T)` | `x: Arc<T>` field + DI |
| `new Mutex<T>(v)` | `std::sync::Mutex::new(v)` |
| `m.lock()` | `m.lock().unwrap()` |
| guard `.get()` / `.set(v)` | `*g` / `*g = v` |
| guard `.push/.iterMut/.remove(i)` | Vec methods through the guard |
| `ch.emit(v)` / `ch.recv()` | `.send(v).unwrap()` / `.recv().unwrap()` |
| `ch.cloneTx()` / `ch.close()` | `.tx.clone()` / `drop(ch.tx)` |
| `for (const v of ch)` | `for v in ch.rx.iter()` |
| `spawn(f)` / `go(f)` | `std::thread::spawn(f)` |
| `() => {...}` | `move \|\| {...}` |
| `for (init;cond;incr)` | `while` (init hoisted, incr at body end) |
| `for (const x of xs)` | `for x in xs` |
| `throw e` | `panic!("{}", e)` |
| `x.length` | `x.len()` |
| `` `a ${b}` `` | `format!("a {}", b)` |
| `x.clone()` | `x.clone()` (all structs derive Clone) |
| `x?.y` / `x ?? y` | not ported — diagnostic |
| `try/finally` | sequential block (no catch — panics aren't caught) |

## Modules & imports

- One source **directory** = one Rust module; root dir = crate root.
- `main.ts` at root emits `pub mod x; pub use x::*;` for non-main siblings
  and `pub mod dir;` for subdirectories.
- Same-dir imports are erased; `./sub` → `crate::sub::X` (`super::` within
  subdirs); `../other` → `crate::other::X`.
- `@Module` classes don't exist as types — imports of them resolve to their
  `new_x` factory fns.
- `import * as nest from "nest"` — required form for the framework.
- `export default <expr>` / `export *` → diagnostics (modules re-export via
  `pub use`, default import is the module itself — unused currently).

## Diagnostics

Two code ranges, both surfaced by `ruts check` and the tsserver plugin:

- **95001** — literal-level type rules the TS checker can't see:
  `let x: Int32 = 1.5`, `Int64(1.5)`.
- **95002** — unsupported constructs: plain unions, object destructuring,
  generators, regex literals, `eval`/`Function`, `arguments`, namespaces,
  `export default`/`export *`, static blocks/accessors, `#private`,
  `accessor`, `with`, `for await`, `using`, `as const`, `import = require`,
  `new Mutex/Channel/Map/Array` without type args, index signatures on
  classes, type predicates, conditional/mapped/template/infer/indexed types,
  `??=`/`||=`/`&&=` in expression position, comma expressions, bodyless
  function decls.

## Not supported (by design or not yet)

Plain `A | B` unions (use enums via `enum`), object destructuring, optional
chaining/nullish coalescing, `try/catch`, `async`/`await`, `switch`,
getters/setters as method pairs (write methods), spread in calls/objects,
default params, labels, `instanceof`/`typeof`/`in`.
