// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { i18n, loadCatalog } from "@console/i18n";
import { SingleKeysCheck } from "./single-keys-check";

i18n.set("en");
await loadCatalog("en");
createRoot(document.getElementById("root")!).render(<main><SingleKeysCheck /></main>);
