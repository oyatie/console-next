use super::register::RegisterQuery;
use crate::{HrError, HrService};
use console_platform_authz::Principal;
use console_platform_excel::umya_spreadsheet;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct RegisterExport {
    pub format: String,
    pub export_purpose: Option<String>,
}

#[derive(Debug)]
pub struct RegisterFile {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub filename: &'static str,
}

impl HrService {
    pub async fn export_worker_register(
        &self,
        principal: Principal,
        query: RegisterQuery,
        export: RegisterExport,
    ) -> Result<RegisterFile, HrError> {
        if !["xlsx", "pdf"].contains(&export.format.as_str()) {
            return Err(HrError::validation("format must be xlsx or pdf"));
        }
        let page = self
            .register_read(
                principal,
                query,
                Some(export.export_purpose.unwrap_or_default()),
            )
            .await?;
        if export.format == "pdf" {
            return Ok(RegisterFile {
                bytes: serde_json::to_vec(&page)
                    .map_err(|_| HrError::internal("register print data could not be written"))?,
                content_type: "application/json",
                filename: "worker-register.json",
            });
        }
        let mut book = umya_spreadsheet::new_file();
        let sheet = book
            .sheet_mut(0)
            .map_err(|_| HrError::internal("workbook has no sheet"))?;
        sheet
            .cell_mut((1u32, 1u32))
            .set_value(format!("{} · {}", page.workplace_name, page.as_of));
        for (n, row) in std::iter::once(&page.headers)
            .chain(page.items.iter().map(|r| &r.cells))
            .enumerate()
        {
            let y = u32::try_from(n)
                .map_err(|_| HrError::internal("register exceeds workbook row limit"))?
                + 2;
            for (x, value) in row.iter().enumerate() {
                let x = u32::try_from(x)
                    .map_err(|_| HrError::internal("register exceeds workbook column limit"))?
                    + 1;
                // Typed string cells: employee text is never treated as a spreadsheet formula.
                sheet.cell_mut((x, y)).set_value_string(value);
            }
        }
        let mut bytes = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes)
            .map_err(|_| HrError::internal("register workbook could not be written"))?;
        Ok(RegisterFile {
            bytes,
            content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename: "worker-register.xlsx",
        })
    }
}
