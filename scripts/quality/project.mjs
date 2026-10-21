import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const hashable = (node, source) => node.getText(source).replace(/\s+/g, " ");
export const isTest = (file) => /\.(test|spec|capture)\.tsx?$/.test(file);
export const platformEntry = (file) => /(?:\.config|\.playwright)\.ts$/.test(file);
export const generated = (file) => /(?:\.d\.ts|\.gen\.tsx?)$/.test(file);

export function sourceFiles(root, dirs) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(file) && !generated(file)) files.push(file);
    }
  };
  dirs.forEach(walk);
  if (!files.length) throw new Error("quality: no source files found");
  return files;
}

export function project(root, files) {
  if (!files.length) throw new Error("quality: no source files supplied");
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"));
  // Worktree node_modules can link to another checkout. Resolve our own workspace sources instead.
  const paths = { ...parsed.options.paths };
  for (const dir of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(root, dir, entry.name, "package.json");
      if (!ts.sys.fileExists(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      for (const [key, value] of Object.entries(json.exports ?? {})) {
        if (typeof value === "string" && /\.tsx?$/.test(value))
          paths[json.name + (key === "." ? "" : key.slice(1))] = [path.resolve(root, dir, entry.name, value)];
      }
    }
  }
  const program = ts.createProgram(files.map((f) => path.join(root, f)), { ...parsed.options, paths });
  const sources = files.map((f) => program.getSourceFile(path.join(root, f)));
  if (sources.some((s) => !s || s.parseDiagnostics.length)) throw new Error("quality: missing or unparseable source");
  return { program, sources, checker: program.getTypeChecker() };
}

export function actual(checker, symbol) {
  return symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
}
