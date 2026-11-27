// SPDX-License-Identifier: LicenseRef-Proprietary
import { session } from "@console/api";
import { activeDrafts } from "../lib/react/draft-owner";

const CONTAINER_SELECTOR = '[data-sheet-layer], dialog[open], [role="dialog"], form, .form, [data-composer-root]';
const NON_TEXT_INPUT = ':not([type="search"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([role="searchbox"]):not([role="combobox"]):not([role="switch"])';
const TRACKED_SELECTOR = `input${NON_TEXT_INPUT}, select, textarea, [contenteditable="true"], [data-form-value]`;
const STANDALONE_TEXT_SELECTOR = `main textarea, main input:not([type="checkbox"]):not([type="radio"])${NON_TEXT_INPUT}`;

const installedDocuments = new WeakSet<Document>();
const initialValues = new WeakMap<Element, string>();
// A submit clears `initialValues` before the screen accepts or refuses it, so a pane is asked against its opening values.
// shortcut: a pane form that saves in place and stays open still reads unsaved, costing one extra Escape; read a saved
// signal from the form once a pane form saves in place.
const openingValues = new WeakMap<Element, string>();

function controlValue(control: Element): string {
  const committed = control.getAttribute("data-form-value");
  if (committed !== null) return committed;
  if (control instanceof HTMLInputElement) {
    return control.type === "checkbox" || control.type === "radio"
      ? `${control.checked}:${control.value}`
      : control.value;
  }
  if (control instanceof HTMLSelectElement) {
    return control.multiple
      ? JSON.stringify([...control.selectedOptions].map(option => option.value))
      : control.value;
  }
  if (control instanceof HTMLTextAreaElement) return control.value;
  return control.getAttribute("contenteditable") === "true" ? (control.textContent ?? "") : "";
}

function defaultDomDirty(control: Element): boolean {
  if (control instanceof HTMLInputElement) {
    return control.type === "checkbox" || control.type === "radio"
      ? control.checked !== control.defaultChecked
      : control.value !== control.defaultValue;
  }
  if (control instanceof HTMLTextAreaElement) return control.value !== control.defaultValue;
  if (control instanceof HTMLSelectElement) {
    const options = [...control.options];
    if (!options.some(option => option.defaultSelected)) return false;
    return options.some(option => option.selected !== option.defaultSelected);
  }
  return false;
}

function shouldIgnore(control: Element, exclude?: Element | null): boolean {
  if (exclude && (control === exclude || exclude.contains(control))) return true;
  if (control.hasAttribute("data-experience-ignore-dirty") || control.closest("[data-experience-ignore-dirty]")) return true;
  if (control.id === "top-locale" || control.id === "acct-locale") return true;
  return false;
}

function snapshot(control: Element) {
  if (shouldIgnore(control)) return;
  for (const baselines of [initialValues, openingValues]) if (!baselines.has(control)) baselines.set(control, controlValue(control));
}

function snapshotTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const control = target.closest(TRACKED_SELECTOR);
  if (control) snapshot(control);
  // A press can set a value elsewhere in its form or sheet, so every control there is recorded before it lands.
  for (const each of target.closest(CONTAINER_SELECTOR)?.querySelectorAll(TRACKED_SELECTOR) ?? []) snapshot(each);
}

function clearFormBaselines(target: EventTarget | null, ...maps: WeakMap<Element, string>[]) {
  if (!(target instanceof Element)) return;
  const form = target.matches("form, .form") ? target : target.closest("form, .form");
  if (!form) return;
  for (const control of form.querySelectorAll(TRACKED_SELECTOR)) {
    for (const baselines of maps) baselines.delete(control);
  }
}

/** Capture clean values before user input mutates any mounted form or sheet control. */
export function installDirtyTracker(doc: Document | undefined = typeof document === "undefined" ? undefined : document) {
  if (!doc || installedDocuments.has(doc)) return;
  installedDocuments.add(doc);
  const capture = (event: Event) => snapshotTarget(event.target);
  doc.addEventListener("focusin", capture, true);
  doc.addEventListener("pointerdown", capture, true);
  doc.addEventListener("keydown", capture, true);
  doc.addEventListener("submit", event => clearFormBaselines(event.target, initialValues), true);
  doc.addEventListener("reset", event => {
    const target = event.target;
    queueMicrotask(() => clearFormBaselines(target, initialValues, openingValues));
  }, true);
}

function hasPersistedSessionDraft(): boolean {
  const principal = session.principal;
  if (!principal || typeof sessionStorage === "undefined") return false;
  for (const [key, draft] of activeDrafts) {
    if (draft.principal !== principal) continue;
    try {
      if (sessionStorage.getItem(key) !== null) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * True while any mounted sheet, dialog or page form under `root` holds unsaved input, or, asked of the whole page, a
 * draft does. Asked of one element (a pane), a form counts against the values it opened with, a submit or not.
 */
export function hasUnsavedInput(
  root: Document | Element | undefined = typeof document === "undefined" ? undefined : document,
  exclude?: Element | null,
): boolean {
  if (!root) return false;
  const pane = root instanceof Element;
  // Drafts are registered by key, not by place, and a stored draft outlives its form.
  if (!pane && hasPersistedSessionDraft()) return true;
  const baselines = pane ? openingValues : initialValues;
  const candidates = new Set<Element>();
  for (const container of root.querySelectorAll(CONTAINER_SELECTOR)) {
    for (const control of container.querySelectorAll(TRACKED_SELECTOR)) candidates.add(control);
  }
  for (const control of root.querySelectorAll(STANDALONE_TEXT_SELECTOR)) candidates.add(control);
  for (const control of candidates) {
    if (shouldIgnore(control, exclude)) continue;
    if (baselines.has(control)) {
      if (controlValue(control) !== baselines.get(control)) return true;
    } else if (defaultDomDirty(control)) {
      return true;
    }
  }
  return false;
}
