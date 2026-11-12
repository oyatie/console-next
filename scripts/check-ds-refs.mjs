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

const COLOUR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark", "device-cmyk"]);
// Every CSS colour name except transparent and currentcolor, which read the same in both themes.
const NAMED_COLOURS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue "
  + "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta "
  + "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink "
  + "deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey "
  + "honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow "
  + "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime "
  + "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen "
  + "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid "
  + "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue "
  + "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle "
  + "tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
/**
 * Whether a declared value writes a colour itself: a hex colour, a colour function or a colour name, anywhere in it
 * (a shadow counts). A value that only names other tokens does not: it follows the theme of what it names.
 */
export function literalColour(value) {
  let found = false;
  valueParser(normalize(value)).walk((node) => {
    const word = decodeIdent(node.value).toLowerCase();
    if (node.type === "function" ? COLOUR_FUNCTIONS.has(word) : node.type === "word" && (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(word) || NAMED_COLOURS.has(word))) found = true;
  });
  return found;
}

/**
 * An experience file's own declarations, by block. The gates compute its overlay on the base from the specificity
 * of exactly two selectors, so anything that would cascade another way is refused: a rule or statement other than
 * the two blocks, a property that is not a token, an !important. So is a colour the light block sets and the dark
 * block does not.
 */
export function experienceBlocks(css, id) {
  const light = `:root[data-experience="${id}"]`, dark = `${light}[data-theme="dark"]`;
  const own = { light: {}, dark: {}, problems: [] };
  const refuse = (node) => {
    const where = node.selector ?? (node.name ? `@${node.name} ${node.params}`.trim() : "a declaration outside any rule");
    own.problems.push(`${where} is not one of the experience's blocks; move its declarations under ${light} or ${dark}`);
  };
  // Every top-level node, not every declaration: an @import carries none, and brings in rules no gate reads.
  for (const node of parseCss(css).nodes) {
    if (node.type === "comment") continue;
    const selector = node.type === "rule" ? node.selector.replaceAll("'", '"') : "";
    const block = selector === light ? own.light : selector === dark ? own.dark : null;
    if (!block) { refuse(node); continue; }
    for (const child of node.nodes) {
      if (child.type === "comment") continue;
      const name = child.type === "decl" ? decodeIdent(child.prop) : "";
      if (child.type !== "decl") refuse(child);
      else if (!name.startsWith("--")) own.problems.push(`${name} is not a token; an experience file sets custom properties only, so remove it`);
      else if (child.important) own.problems.push(`${name} is marked !important, which the order of the light and dark blocks does not account for; drop !important`);
      else block[name] = child.value.trim();
    }
  }
  // In dark the light block still applies, ahead of the base's dark block: a light colour with no dark value shows in dark.
  for (const [name, value] of Object.entries(own.light)) {
    if (literalColour(value) && !Object.hasOwn(own.dark, name))
      own.problems.push(`${name} is a colour set for light only, so dark would show its light value; set it in ${dark} too`);
  }
  return own;
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
