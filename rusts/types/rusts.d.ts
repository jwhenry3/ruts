// rusts — ambient Rust type declarations.
// These names map 1:1 to Rust types at emit time. Numeric types are branded
// so i32 and f64 are nominally distinct, like Rust itself.

declare type Int32 = number & { readonly __rusts: "i32" };
declare type Int64 = number & { readonly __rusts: "i64" };
declare type Int = number & { readonly __rusts: "i32" };
declare type Float32 = number & { readonly __rusts: "f32" };
declare type Float64 = number & { readonly __rusts: "f64" };
declare type Usize = number & { readonly __rusts: "usize" };
declare type Bool = boolean;
declare type Str = string;
declare type Void = void;
declare type Null = null;
declare type Any = any;
declare type Error = globalThis.Error;

// Ptr<T> — borrow semantics. In params maps to &T (or &mut Ctx); elsewhere T.
declare type Ptr<T> = T;

// numeric conversions — Int32(x) -> x as i32 at emit time
declare function Int(v: number): Int;
declare function Int32(v: number): Int32;
declare function Int64(v: number): Int64;
declare function Usize(v: number): Usize;
declare function Float32(v: number): Float32;
declare function Float64(v: number): Float64;

// .clone() — every generated struct derives Clone; strings/slices clone too.
interface Object { clone<T extends Object>(this: T): T }
interface String { clone(): string }
interface Array<T> { clone(): T[] }

// Mutex<T> — std::sync::Mutex. .lock() yields a guard; guard.get() derefs.
declare interface MutexGuard<T> {
    get(): T;
    set(v: T): void;
    iter(): T extends Array<infer E> ? E[] : T;
    iterMut(): T extends Array<infer E> ? E[] : T;
    push(v: any): void;
    remove(idx: Usize): void;
    clone(): T;
}
declare class Mutex<T> {
    constructor(v: T);
    lock(): MutexGuard<T>;
}

// ChanSender<T> — a cloned Sender half; .emit sends, .close drops this sender.
declare class ChanSender<T> {
    emit(v: T): void;
    close(): void;
}

// Channel<T> — std::sync::mpsc. .emit sends, .recv receives,
// .cloneTx() gives a second Sender for a spawned thread, .close() drops tx.
declare class Channel<T> {
    constructor(cap?: Int32);
    emit(v: T): void;
    recv(): T;
    cloneTx(): ChanSender<T>;
    close(): void;
}

declare function go(f: (...args: any[]) => void, ...args: any[]): void;
declare function spawn(f: (...args: any[]) => void, ...args: any[]): void;

declare function parseInt(s: string): Int32;
declare function println(...args: any[]): void;

declare namespace console {
    function log(...args: any[]): void;
}
