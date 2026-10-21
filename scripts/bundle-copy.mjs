import ts from "typescript";

/** Search decoded JavaScript strings, so spreadsheet identifiers such as getTables are not UI copy. */
export function leakedCopy(source, copy) {
  const values = [];
  const file = ts.createSourceFile("bundle.js", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) values.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return copy.filter((text) => values.some((value) => value.includes(text)));
}
