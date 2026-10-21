import { expect, type BrowserContext } from "@playwright/test";
import { bootKo } from "../packages/i18n/src/catalogs/boot";
import { ko } from "../packages/i18n/src/catalogs/ko";

/** Every catalog id (en has the same ids): what `t()` paints as-is when its catalog is not loaded. */
const CATALOG_IDS = [...Object.keys(bootKo), ...Object.keys(ko)];

/**
 * In the page, from the first node on: reports each text the page paints that is a catalog id, even for a frame
 * (a banner drawn before its catalog loaded, then replaced). Self-contained: it is serialized into the page.
 */
function watchRawIds(ids: string[]) {
  const known = new Set(ids);
  const seen = new Set<string>();
  const report = (window as unknown as { __rawI18nId?: (id: string) => void }).__rawI18nId;
  const HIDDEN = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
  const scan = (text: string | null) => {
    for (const token of text?.match(/[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g) ?? [])
      if (known.has(token) && !seen.has(token)) {
        seen.add(token);
        report?.(token);
      }
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) return void (HIDDEN.has(node.parentElement?.tagName ?? "") || scan(node.textContent));
    if (node.nodeType !== Node.ELEMENT_NODE || HIDDEN.has((node as Element).tagName)) return;
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walk.nextNode(); text; text = walk.nextNode()) if (!HIDDEN.has(text.parentElement?.tagName ?? "")) scan(text.textContent);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") visit(r.target);
      else r.addedNodes.forEach(visit);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

/** Fails the running test (softly, like guardConsole) for each catalog id painted raw in `context`. */
export async function guardRawIds(context: BrowserContext) {
  await context.exposeBinding("__rawI18nId", (_source, id: string) => {
    expect.soft(id, `a raw i18n id was painted (its catalog was not loaded, or the id is missing)`).toBe("");
  });
  await context.addInitScript(watchRawIds, CATALOG_IDS);
}
