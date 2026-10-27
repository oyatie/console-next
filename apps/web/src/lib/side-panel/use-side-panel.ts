// SPDX-License-Identifier: LicenseRef-Proprietary
import { useNavigate, useSearch } from "@tanstack/react-router";

/** The route validates `sel` as an optional string. Opening adds a history entry; Back closes before leaving. */
export function useSidePanel() {
  const selected = useSearch({ strict: false, select: search => typeof search.sel === "string" && search.sel ? search.sel : undefined });
  const navigate = useNavigate();
  return {
    selected,
    select: (id: string) => void navigate({ to: ".", search: previous => ({ ...previous, sel: id }) }),
    close: () => void navigate({ to: ".", search: previous => ({ ...previous, sel: undefined }), replace: true }),
  };
}
