// rusts tsserver plugin for the nestrs project — self-contained copy of
// rusts/plugin + rusts/src/checks.cjs. Keep in sync when checks change.

const { allDiagnostics } = require("./checks.cjs");

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
