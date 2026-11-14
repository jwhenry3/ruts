// nestrs — ambient declarations for the nest framework crate + decorators.
// Decorators are compile-time metadata erased at emit; they drive wiring.

declare module "nest" {
    export type Error = globalThis.Error;

    export interface Ctx {
        method: Str;
        path: Str;
        Param(key: Str): Str;
        ParamInt(key: Str): [Int32, Ptr<Error> | null];
        Query(key: Str): Str;
        Header(key: Str): Str;
        SetHeader(key: Str, val: Str): void;
        Status(code: Int32): void;
        JSON(v: Any): [Any, Ptr<Error> | null];
        Render(name: Str): [Any, Ptr<Error> | null];
        Body(): Any;
        Elapsed(): Str;
    }

    // interceptor wrap-chain: `next(c)` invokes the rest of the pipeline
    export type Next = (c: Ptr<Ctx>) => [Any, Error | null];

    export interface App {
        SetGlobalPrefix(prefix: Str): void;
        SetViews(glob: Str): void;
        Listen(port: Str): void;
    }

    export function Create(m: Any): App;
    export function envOr(key: Str, fallback: Str): Str;

    export function BadRequestException(msg: Str): Error;
    export function UnauthorizedException(msg: Str): Error;
    export function ForbiddenException(msg: Str): Error;
    export function NotFoundException(msg: Str): Error;
    export function ConflictException(msg: Str): Error;
    export function InternalServerErrorException(msg: Str): Error;
}

// --- ambient decorators (no import needed) ---
declare function Module(meta: { imports?: any[]; controllers?: any[]; providers?: any[]; exports?: any[] }): ClassDecorator;
declare function Controller(prefix: Str): ClassDecorator;
declare function Injectable(): ClassDecorator;
declare function Get(path?: Str): MethodDecorator;
declare function Post(path?: Str): MethodDecorator;
declare function Patch(path?: Str): MethodDecorator;
declare function Delete(path?: Str): MethodDecorator;
declare function UseGuards(...guards: any[]): MethodDecorator & ClassDecorator;
declare function UseInterceptors(...interceptors: any[]): MethodDecorator & ClassDecorator;
declare function UseFilters(...filters: any[]): MethodDecorator & ClassDecorator;
