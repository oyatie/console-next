import { renderToStaticMarkup } from "react-dom/server";
import type { RegisterPage } from "../../../reference/statutory/api";
import { RecordRows } from "../../../ui/record/rows";

/** Only audited, scoped export rows become the standalone browser print document. */
export function registerPrintHtml(page: RegisterPage) {
  return "<!doctype html>" + renderToStaticMarkup(<html lang="ko"><head>
    <meta charSet="utf-8" /><title>{page.workplace_name}</title><link rel="stylesheet" href="/statutory-register-print.css" />
  </head><body><h1>{page.workplace_name}</h1><time dateTime={page.as_of}>{page.as_of}</time>
    <RecordRows<RegisterPage["items"][number]> label={page.workplace_name} rows={page.items} rowId={(r) => r.employee_id}
      columns={page.headers.map((header, i) => ({ header, cell: (r) => r.cells[i] }))} />
  </body></html>);
}
