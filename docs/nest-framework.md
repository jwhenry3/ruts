# nest — the framework crate

`nestrs/nest` is a hand-written Rust crate providing the NestJS runtime
model: modules, DI, controllers, guards, interceptors, filters, views,
and a small built-in HTTP server. Generated ruts code calls into it;
it is never generated itself.

## Decorator catalog (compile-time)

| decorator | emits |
|---|---|
| `@Module({imports,controllers,providers,exports})` | `pub fn new_x(deps: &mut nest::Deps) -> nest::Module` — providers `deps.register`ed, controllers wrapped in `Arc`, routes built, imports chained via `.import(factory(deps))` |
| `@Controller("/prefix")` | `nest::Controller::new("/prefix")` builder |
| `@Get/@Post/@Patch/@Delete(path)` | `.get/.post/.patch/.delete(path, handler)` on the controller builder; handler = `Arc::new(move \|ctx, body\| -> Result<Value, Error> { c.method(ctx[, body]) })` |
| `@Injectable()` | `new()` constructor; resolved via `deps.get::<T>()` |
| `@UseInterceptors(X)` (class) | `.interceptor(X::new(...))` on the builder |
| `@UseGuards(G)` (method) | `.{method}_g(path, handler, nest::with_guard(G::new(...)))` route variant |
| method param `body: Dto` | `serde_json::from_value` + `Validatable::validate` before dispatch |

## DI model

- `@Module` providers are `Arc::new(X::new(deps.get::<Dep>(), ...))`'d in
  declaration order, each registered into `Deps` (a `TypeId -> Arc<dyn Any>` map).
- Controller/guard/interceptor ctor params (`constructor(private x: T)`)
  resolve from `Deps` — cross-module deps work when the providing module is
  imported first.
- `deps.get::<T>()` panics with the type name when a provider is missing —
  DI failures are loud at boot, like NestJS.

## Handler contract

Controller methods have the shape:

```ts
method(c: Ptr<nest.Ctx> [, body: SomeDto]): [Any, Error | null]
```

`Ptr<nest.Ctx>` → `&mut nest::Ctx`. The `[Any, Error | null]` return →
`Result<serde_json::Value, nest::Error>`; `Err` propagates to the framework
which writes the HTTP status + `{message}` JSON.

When the method has a second param, the handler deserializes the request
body into the DTO and calls `Validatable::validate` first — `Err` becomes
400 before your method runs.

## Ctx API

```ts
c.Param("id")        // String path param
c.ParamInt("id")     // (i32, Option<Error>) — destructure + null-check
c.Query("q")         // String query param
c.Header("x-k")      // String request header
c.SetHeader(k, v)    // set response header
c.Status(201)        // set response status
c.JSON(v)            // [Any, Ptr<Error>|null] — write JSON body
c.Render("index")    // [Any, Ptr<Error>|null] — render a view file
c.Body()             // raw body as Any
```

## Exceptions

`nest.BadRequestException`, `UnauthorizedException`, `ForbiddenException`,
`NotFoundException`, `ConflictException`, `InternalServerErrorException` —
each takes a message, returns `nest::Error` carrying status + message.

```ts
return [null!, nest.NotFoundException(`user ${id} not found`)];
```

## Guards / interceptors

```ts
@Injectable()
export class AuthGuard implements nest.Guard {
    constructor(private config: ConfigService) {}
    canActivate(ctx: Ptr<nest.Ctx>): Bool {
        return ctx.Header("x-api-key") === this.config.get("API_KEY");
    }
}
```

`impl nest::Guard` — `fn check(&self, ctx: &Ctx) -> bool`. Interceptors:
`impl nest::Interceptor` — `fn intercept(&self, ctx: &Ctx, next: Next) -> Result<Value, Error>`
style wrap around handlers (logging/timing in the example app).

## Views

`app.SetViews("views/*.html")` — glob resolved relative to the crate root.
`c.Render("index")` reads `views/index.html` and serves it as `text/html`.

## Server

`nest::create(module)` → `App`; `set_global_prefix("/api")`, `listen(port)`.
Per-connection `std::thread::spawn` — routes are `Arc`-shared. Route params
use `{name}` segments (e.g. `/users/{id}`).
