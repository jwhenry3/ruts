// ruts concurrency — Channel<T> maps to std::sync::mpsc, spawn() to std::thread.

const ch = new Channel<Int32>();
const tx = ch.cloneTx();

spawn(() => {
    for (let i = 0 as Int32; i < 3; i = Int32(i + 1)) {
        tx.emit(i);
    }
    tx.close();
});
ch.close();

for (const v of ch) {
    console.log(`got ${v}`);
}
