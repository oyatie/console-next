// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Resolves a field name to its corresponding interactive DOM element on the page.
 * Returns null if the field is not present in the DOM (e.g. a server-only field).
 */
export function findFieldElement(fieldName?: string, formId?: string): HTMLElement | null {
  if (typeof document === "undefined" || !fieldName) return null;
  const root = formId ? document.getElementById(formId) : document;
  if (!root) return null;

  try {
    const escaped = CSS.escape(fieldName);
    // 1. Exact ID match
    const byId = root.querySelector<HTMLElement>(`#${escaped}`);
    if (byId) return byId;

    // 2. Name attribute match
    const byName = root.querySelector<HTMLElement>(`[name="${escaped}"]`);
    if (byName) return byName;

    // 3. Data-field attribute container match
    const byData = root.querySelector<HTMLElement>(`[data-field="${escaped}"]`);
    if (byData) {
      const control = byData.querySelector<HTMLElement>("input, select, textarea, button, [tabindex]");
      return control ?? byData;
    }

    // 4. Common field prefix pattern
    const byPattern = root.querySelector<HTMLElement>(`#field-${escaped}, #${escaped}-input`);
    if (byPattern) return byPattern;
  } catch {
    return root.querySelector<HTMLElement>(`[name="${fieldName}"]`);
  }

  return null;
}
