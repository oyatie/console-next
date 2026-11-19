// SPDX-License-Identifier: LicenseRef-Proprietary
import { session } from "@console/api";
import { activeDrafts } from "../lib/react/draft-owner";

const CONTAINER_SELECTOR = '[data-sheet-layer], dialog[open], [role="dialog"], form, .form, [data-composer-root]';
const TRACKED_SELECTOR = 'input:not([type="search"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([role="searchbox"]):not([role="combobox"]):not([role="switch"]), select, textarea, [contenteditable="true"], [data-form-value]';
const STANDALONE_TEXT_SELECTOR = 'main textarea, main input:not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([role="searchbox"]):not([role="combobox"]):not([role="switch"])';

const installedDocuments = new WeakSet<Document>();
const initialValues = new WeakMap<Element, string>();

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

function snapshotTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const control = target.matches(TRACKED_SELECTOR) ? target : target.closest(TRACKED_SELECTOR);
  if (control && !shouldIgnore(control) && !initialValues.has(control)) {
    initialValues.set(control, controlValue(control));
  }
}

function clearFormBaselines(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const form = target.matches("form, .form") ? target : target.closest("form, .form");
  if (!form) return;
  for (const control of form.querySelectorAll(TRACKED_SELECTOR)) {
    initialValues.delete(control);
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
  doc.addEventListener("submit", event => clearFormBaselines(event.target), true);
  doc.addEventListener("reset", event => {
    const target = event.target;
    queueMicrotask(() => clearFormBaselines(target));
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

/** True while any mounted sheet, dialog, page form, or draft holds unsaved input. */
export function hasUnsavedInput(
  root: Document | Element | undefined = typeof document === "undefined" ? undefined : document,
  exclude?: Element | null,
): boolean {
  if (hasPersistedSessionDraft()) return true;
  if (!root) return false;
  const candidates = new Set<Element>();
  for (const container of root.querySelectorAll(CONTAINER_SELECTOR)) {
    for (const control of container.querySelectorAll(TRACKED_SELECTOR)) candidates.add(control);
  }
  for (const control of root.querySelectorAll(STANDALONE_TEXT_SELECTOR)) candidates.add(control);
  for (const control of candidates) {
    if (shouldIgnore(control, exclude)) continue;
    if (initialValues.has(control)) {
      if (controlValue(control) !== initialValues.get(control)) return true;
    } else if (defaultDomDirty(control)) {
      return true;
    }
  }
  return false;
}
