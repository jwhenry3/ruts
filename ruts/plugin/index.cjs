// ruts tsserver plugin — surfaces ruts-specific diagnostics as live editor
// squiggles. Plugins can ADD diagnostics but not remove them, so this layers
// our checks (float literal -> int type, unsupported constructs) on top of the
// real checker's errors (which already cover branded-type assignability).
//
// Registered via tsconfig.json: "plugins": [{ "name": "./plugin" }]

const { allDiagnostics } = require("../src/checks.cjs");

function init(/* { typescript: tss } */) {
  function create(info) {
    const ls = info.languageService;
    const proxy = Object.create(null);
    for (const k in ls) {
      const orig = ls[k];
      if (typeof orig === "function") proxy[k] = (...args) => orig.apply(ls, args);
    }
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = ls.getSemanticDiagnostics(fileName);
      if (fileName.endsWith(".d.ts") || !fileName.endsWith(".ts")) return prior;
      const sf = ls.getProgram()?.getSourceFile(fileName);
      return sf ? prior.concat(allDiagnostics(sf)) : prior;
    };
    return proxy;
  }
  return { create };
}

module.exports = init;
