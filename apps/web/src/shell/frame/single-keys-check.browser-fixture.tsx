// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { i18n, loadCatalog, t } from "@console/i18n";
import { KeyValue } from "../../ui/key-value/key-value";
import { SingleKeysCheck } from "./single-keys-check";
import "../../app.css";

i18n.set("en");
await loadCatalog("en");
// The row as the account page's profile card draws it.
createRoot(document.getElementById("root")!).render(<main><KeyValue items={[{ key: "shortcuts", label: t("account.field.shortcuts"), value: <SingleKeysCheck /> }]} /></main>);
