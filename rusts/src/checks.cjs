// rusts semantic checks — rules TypeScript's checker can't express.
// Shared by the emitter (src/emitter.ts) and the tsserver plugin
// (plugin/index.cjs). Plain CJS so tsserver can require() it.

const ts = require("typescript");

// Rust integer type names (emitted form).
const INT_TYPES = new Set([
  "i8", "i16", "i32", "i64", "i128", "isize",
  "u8", "u16", "u32", "u64", "u128", "usize",
]);

// Every spelling that maps to a Rust int type -> its Rust name.
const INT_SPELLINGS = {
  i8: "i8", i16: "i16", i32: "i32", i64: "i64", i128: "i128", isize: "isize",
  u8: "u8", u16: "u16", u32: "u32", u64: "u64", u128: "u128", usize: "usize",
  Int: "i32", Int32: "i32", Int64: "i64", Usize: "usize",
};

// `1e4`, `3.14`, `.5` -> float; `0x1e4`, `0b101`, `0o17`, `42` -> int
function isFloatLiteralText(text) {
  return !/^0[xXbBoO]/.test(text) && /[.eE]/.test(text);
}

function unwrapCast(e) {
  return ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? e.expression : e;
}

// declared-type source text -> Rust int base name, or undefined.
// `Int32` -> "i32", `Int32[]` -> "i32", `Vec<Int32>` -> "i32"
function rustIntBaseOfTypeText(text) {
  let t = text.trim();
  while (t.endsWith("[]")) t = t.slice(0, -2);
  const vec = /^Vec<(.+)>$/.exec(t);
  if (vec) t = vec[1].trim();
  return INT_SPELLINGS[t];
}

// Walk the AST and produce the rusts-specific diagnostics the TS checker
// cannot see (it can't inspect literal values). Each diag is a plain object
// shaped like ts.Diagnostic so both the emitter and the plugin can use it.
function rustsDiagnostics(sf) {
  const diags = [];
  const push = (node, messageText) => diags.push({
    file: sf, start: node.getStart(sf), length: node.getWidth(sf),
    messageText, category: ts.DiagnosticCategory.Error,
    code: 95001, source: "rusts",
  });
  const visit = (n) => {
    // let x: Int32 = 1.5  /  let s: Int32[] = [1.5]  /  param/property defaults
    if ((ts.isVariableDeclaration(n) || n.kind === ts.SyntaxKind.Parameter ||
         ts.isPropertyDeclaration(n)) && n.type && n.initializer) {
      const base = rustIntBaseOfTypeText(n.type.getText(sf));
      if (base) {
        const inits = ts.isArrayLiteralExpression(n.initializer)
          ? [...n.initializer.elements] : [n.initializer];
        for (const raw of inits) {
          const lit = unwrapCast(raw);
          if (ts.isNumericLiteral(lit) && isFloatLiteralText(lit.getText(sf)))
            push(lit, `non-integer literal ${lit.getText(sf)} assigned to ${n.type.getText(sf)} (Rust ${base})`);
        }
      }
    }
    // Int64(1.5)
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
        INT_SPELLINGS[n.expression.text] && n.arguments.length === 1) {
      const a0 = unwrapCast(n.arguments[0]);
      if (ts.isNumericLiteral(a0) && isFloatLiteralText(a0.getText(sf)))
        push(a0, `non-integer literal ${a0.getText(sf)} cannot convert to ${n.expression.text} (Rust ${INT_SPELLINGS[n.expression.text]})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return diags;
}

// ---------- unsupported-construct diagnostics (code 95002) ----------------
// rusts compiles a TS subset to Rust — these constructs typecheck fine in TS
// but have no Rust equivalent (or no mapping yet). Flag them early so the
// editor and `rusts check` report them instead of emitting broken Rust.

function hasMod2(n, kind) {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some(m => m.kind === kind);
}

// `T | null` / `T | undefined` erase to Option<T> — anything else is a plain
// union, which Rust needs an enum for.
function isNullishType(t) {
  return t.kind === ts.SyntaxKind.NullKeyword ||
    t.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(t) &&
      (t.literal.kind === ts.SyntaxKind.NullKeyword ||
       t.literal.kind === ts.SyntaxKind.UndefinedKeyword));
}
function isNullableUnion(u) {
  const nonNull = u.types.filter(t => !isNullishType(t));
  return nonNull.length === 1 && nonNull.length < u.types.length;
}

// binding patterns that rusts can destructure (flat, no defaults/rest/nesting)
function bindingOk(pat) {
  return pat.elements.every(el =>
    !ts.isOmittedExpression(el) && !el.dotDotDotToken && !el.initializer &&
    ts.isIdentifier(el.name) && (!el.propertyName || ts.isIdentifier(el.propertyName)));
}

function unsupportedDiagnostics(sf) {
  const diags = [];
  const push = (node, messageText) => diags.push({
    file: sf, start: node.getStart(sf), length: node.getWidth(sf),
    messageText, category: ts.DiagnosticCategory.Error,
    code: 95002, source: "rusts",
  });
  const visit = (n) => {
    if (ts.isUnionTypeNode(n) && !isNullableUnion(n))
      push(n, "unions are not supported except 'T | null' -> Option<T> (Rust has enums, not union types)");
    if (ts.isWithStatement(n)) push(n, "'with' is not supported");
    if (ts.isSpreadAssignment(n)) push(n, "spread in object literals is not supported");
    if (ts.isYieldExpression(n)) push(n, "generators are not supported — use iterators or channels");
    if ((ts.isCommaListExpression(n) ||
         (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken)) &&
        !(n.parent && ts.isForStatement(n.parent)))
      push(n, "comma expressions are not supported");
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) ||
         ts.isFunctionExpression(n)) && n.asteriskToken)
      push(n, "generator functions are not supported");
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && !n.body)
      push(n, "overloads and 'declare' signatures are not supported — declare belongs in .d.ts");
    if (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
         n.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
         n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) &&
        !(n.parent && ts.isExpressionStatement(n.parent)))
      push(n, "'??='/'||='/'&&=' are only supported as statements");
    if (ts.isExportAssignment(n))
      push(n, "'export default <expr>' is not supported — the module itself is the default import; export by name");
    if (ts.isExportDeclaration(n)) {
      if (!n.exportClause) push(n, "'export *' is not supported — modules re-export via 'pub use'");
      else for (const el of n.exportClause.elements)
        if (el.name.text === "default")
          push(el, "rusts has no default exports — the module itself is the default import");
    }
    if ((ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) &&
        hasMod2(n, ts.SyntaxKind.StaticKeyword))
      push(n, "static accessors are not supported");
    if (ts.isClassStaticBlockDeclaration(n))
      push(n, "static blocks are not supported — use a module-level fn or lazy static");
    if (n.kind === ts.SyntaxKind.Parameter && ts.isArrayBindingPattern(n.name) && !bindingOk(n.name))
      push(n.name, "destructured params support flat names only — no nesting, defaults, or rest");
    if (n.kind === ts.SyntaxKind.Parameter && ts.isObjectBindingPattern(n.name))
      push(n.name, "object destructuring is not supported — access fields directly");
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && !bindingOk(n.name))
      push(n.name, "destructuring supports flat names only — no nesting, defaults, or rest");
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name))
      push(n.name, "object destructuring is not supported — access fields directly");
    if (ts.isPropertyDeclaration(n) && ts.isPrivateIdentifier(n.name))
      push(n, "#private fields are not supported — fields are private by default in Rust");
    if (ts.isPropertyDeclaration(n) && hasMod2(n, ts.SyntaxKind.AccessorKeyword))
      push(n, "auto-accessors are not supported — write explicit get/set");
    if (ts.isModuleDeclaration(n))
      push(n, "namespaces/modules are not supported — one directory is one Rust module");
    if (ts.isIdentifier(n) && n.text === "arguments" &&
        !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n))
      push(n, "'arguments' is not supported — use rest params (...args)");
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
        (n.expression.text === "eval" || n.expression.text === "Function"))
      push(n, `'${n.expression.text}' is not supported`);
    if (ts.isRegularExpressionLiteral(n))
      push(n, "regex literals are not supported — depend on the regex crate");
    if (ts.isForOfStatement(n) && n.awaitModifier)
      push(n, "'for await' is not supported — loop over a channel receiver");
    // AwaitUsing is a mask (Const|Using) — the Using bit alone covers both
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Using))
      push(n, "'using' declarations are not supported — Rust drops handle it");
    if (ts.isAsExpression(n) && ts.isTypeReferenceNode(n.type) &&
        n.type.typeName.getText() === "const")
      push(n, "'as const' is not supported — declare a const or a literal type");
    if (ts.isImportEqualsDeclaration(n))
      push(n, "'import x = require()' is not supported — use ES import syntax");
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) &&
        (n.expression.text === "Channel" || n.expression.text === "Mutex" ||
         n.expression.text === "Map" || n.expression.text === "Array") && !n.typeArguments?.length)
      push(n, `new ${n.expression.text}<T>(...) needs its type arguments`);
    if (ts.isIndexSignatureDeclaration(n) && n.parent && ts.isClassLike(n.parent))
      push(n, "index signatures are not supported on classes");
    if (ts.isTypePredicateNode(n))
      push(n, "type predicates ('x is T'/'asserts x') are not supported");
    if (ts.isConditionalTypeNode(n) || ts.isMappedTypeNode(n) ||
        ts.isTemplateLiteralTypeNode(n) || ts.isInferTypeNode(n) ||
        ts.isIndexedAccessTypeNode(n))
      push(n, "advanced type operators (conditional/mapped/template/infer/indexed) are not supported");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return diags;
}

function allDiagnostics(sf) {
  return [...rustsDiagnostics(sf), ...unsupportedDiagnostics(sf)];
}

module.exports = { INT_TYPES, INT_SPELLINGS, isFloatLiteralText, unwrapCast, rustIntBaseOfTypeText, rustsDiagnostics, unsupportedDiagnostics, allDiagnostics };
