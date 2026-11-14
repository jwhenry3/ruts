// ruts hello — TypeScript syntax, Rust output.

interface Person {
    name: Str;
    age: Int32;
}

function greet(p: Person): Str {
    return `hello, ${p.name} — age ${p.age}`;
}

const p: Person = { name: "ferris", age: 14 as Int32 };
console.log(greet(p));

const xs: Int32[] = [1, 2, 3];
let total: Int32 = 0 as Int32;
for (const x of xs) total = Int32(total + x);
console.log(`total: ${total}`);
