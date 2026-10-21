import ts from "typescript";
import { digest } from "./ratchet.mjs";

const MIN_TOKENS = 100;
const MIN_LINES = 8;

export function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const out = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
    out.push({ text: `${scanner.getToken()}:${scanner.getTokenText()}`, pos: scanner.getTokenPos() });
  return out;
}

// Exact tokens deliberately retain names/literals: near-clones need contextual review.
export function clones(sources) {
  const seen = new Map(), covered = new Map(), findings = {};
  for (const { file, text } of sources) {
    const stream = tokens(text);
    for (let i = 0; i + MIN_TOKENS <= stream.length; i++) {
      const block = stream.slice(i, i + MIN_TOKENS);
      if (text.slice(block[0].pos, block.at(-1).pos).split("\n").length < MIN_LINES) continue;
      const hash = digest(block.map((t) => t.text).join("\0"));
      const prior = seen.get(hash);
      if (!prior) {
        seen.set(hash, { file, stream, index: i });
        continue;
      }
      if (prior.file === file && i < prior.index + MIN_TOKENS) continue;
      const pair = `${prior.file}:${file}`;
      if (i < (covered.get(pair) ?? 0)) continue;
      let length = MIN_TOKENS;
      while (stream[i + length] && prior.stream[prior.index + length]?.text === stream[i + length].text) length++;
      covered.set(pair, i + length);
      const key = `clone:${pair}:${hash}`;
      findings[key] = (findings[key] ?? 0) + 1;
    }
  }
  return findings;
}
