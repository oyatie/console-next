// SPDX-License-Identifier: LicenseRef-Proprietary
import path from "node:path";
import { parse } from "postcss";
import valueParser from "postcss-value-parser";
import ts from "typescript";

const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/gi;
const normalize = (css) => css.replace(CSS_ESCAPE, (escape, hex, ch) => {
  // Fixed-width escapes preserve whitespace inside identifiers in both parsers.
  if (!hex && ch !== " " && ch !== "\t") return escape;
  return `\\${(hex ?? ch.codePointAt(0).toString(16)).padStart(6, "0")}`;
});
export const parseCss = (css, from) => parse(normalize(css), { from });
export const decodeIdent = (raw) => raw.replace(CSS_ESCAPE, (_, hex, ch) => {
  if (ch !== undefined) return ch;
  const cp = parseInt(hex, 16);
  return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCodePoint(cp);
});

export function context(node) {
  const headers = [];
  for (let parent = node; parent; parent = parent.parent) {
    if (parent.type === "rule") headers.push(parent.selector);
    if (parent.type === "atrule") headers.push(`@${parent.name} ${parent.params}`);
  }
  const theme = headers.some((h) => /data-theme\s*=\s*["']?dark|prefers-color-scheme\s*:\s*dark/.test(h)) ? "dark"
    : headers.some((h) => /data-theme\s*=\s*["']?light|prefers-color-scheme\s*:\s*light/.test(h)) ? "light" : null;
  const conditions = headers.filter((h) => h.startsWith("@") && !/^@(?:layer|property)\b/.test(h))
    .filter((h) => !/^@media\s*\(prefers-color-scheme\s*:\s*(dark|light)\)$/.test(h));
  return { theme, conditions };
}
export function rootDeclaration(decl) {
  return decl.parent?.type === "rule" && /:root\b/.test(decl.parent.selector);
}
const permits = (definition, use, theme) => (!definition.theme || definition.theme === theme)
  && definition.conditions.every((condition) => use.conditions.includes(condition));

function definitions(sheet, global = false) {
  const result = [];
  sheet.walkDecls((decl) => {
    const name = decodeIdent(decl.prop);
    if (name.startsWith("--") && (!global || rootDeclaration(decl))) result.push({ name, ...context(decl) });
  });
  if (!global) sheet.walkAtRules("property", (rule) => {
    const name = decodeIdent(rule.params.trim());
    if (name.startsWith("--")) result.push({ name, ...context(rule) });
  });
  return result;
}
const varName = (node) => {
  const comma = node.nodes.findIndex((part) => part.type === "div" && part.value === ",");
  const parts = (comma < 0 ? node.nodes : node.nodes.slice(0, comma)).filter((part) => part.type !== "comment");
  while (parts[0]?.type === "space") parts.shift();
  while (parts.at(-1)?.type === "space") parts.pop();
  return decodeIdent(valueParser.stringify(parts));
};
const references = (value) => {
  const names = [];
  valueParser(normalize(value)).walk((node) => {
    if (node.type === "function" && decodeIdent(node.value).toLowerCase() === "var") names.push(varName(node));
  });
  return names;
};

function sourceContracts(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set();
  const uses = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith("--")) names.add(node.name.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "setProperty" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith("--")) names.add(node.arguments[0].text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) uses.push(...references(node.text));
    if (ts.isTemplateExpression(node)) for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)]) uses.push(...references(part.text));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const modules = ast.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier)
    .filter(ts.isStringLiteral).map((node) => node.text).filter((name) => name.startsWith(".") && name.endsWith(".css"))
    .map((name) => path.posix.join(path.posix.dirname(file), name));
  return { defined: [...names].map((name) => ({ name, theme: null, conditions: [] })), uses, modules };
}

/** One hard-failure list, shared by the gate and reference fixtures; no baseline can admit a name. */
export function brokenRefs(sources, sheets, tokensFile) {
  const globals = sheets.has(tokensFile) ? definitions(sheets.get(tokensFile), true) : [];
  const contracts = new Map([...sources].filter(([file]) => /\.tsx?$/.test(file)).map(([file, src]) => [file, sourceContracts(file, src)]));
  const runtime = new Map();
  for (const [file, { defined, modules }] of contracts) {
    for (const owner of [file, ...modules]) runtime.set(owner, [...(runtime.get(owner) ?? []), ...defined]);
  }
  const problems = [];
  for (const [file] of sources) {
    const sheet = sheets.get(file);
    const local = sheet ? definitions(sheet) : [];
    const defined = [...globals, ...local, ...(runtime.get(file) ?? [])];
    const seen = new Set();
    const check = (name, use) => {
      if (!seen.has(name) && (!name.startsWith("--") || (use.theme ? [use.theme] : ["light", "dark"]).some((theme) => !defined.some((d) => d.name === name && permits(d, use, theme))))) {
        seen.add(name);
        problems.push(`${file}: broken var reference var(${name}) — token undefined in packages/tokens/tokens.css or local module (visual-language §10)`);
      }
    };
    if (sheet) sheet.walkDecls((decl) => {
      for (const name of references(decl.raws.value?.raw ?? decl.value)) check(name, context(decl));
    });
    else for (const name of contracts.get(file)?.uses ?? []) check(name, { theme: null, conditions: [] });
  }
  return problems;
}
