//! `GET /employees/export.csv?layout=register`: the filtered rows as a
//! 근로자 명부 (SC-HRR-003; hr-reports-registers §1 L1–L4).
//!
//! Columns follow 근로기준법 시행규칙 별지 제16호서식 (개정 2024-07-29), which
//! carries the 시행령 §20 items: 1 성명 · 2 성별 · 3 생년월일 · 4 주소 · 5 이력 ·
//! 6 종사하는 업무의 종류 · 7 고용 또는 고용갱신 연월일, 계약기간 · 8 해고·퇴직·사망
//! 연월일과 사유 · 9 그 밖에 필요한 사항 (근기법 §41①, 시행령 §20, read
//! 2026-10-03 from law.go.kr DRF: 근로기준법 MST=290781, 시행령 MST=270551,
//! 시행규칙 MST=269393). 사번, 사업장 and 소속 lead each row so a 사업장's
//! register can be cut from the file (§41① 「각 사업장별로」).
//!
//! An item not recorded is an empty cell, never a guess (HR-6: empty =
//! 미입력). 성별, 주소, 이력, 퇴직 사유 and 기타 are the MR-23 register facts
//! (`register_facts`); the 퇴직 사유 is the code's label (system or tenant).
//! Labels only (근기법 §40): no internal code, id or flag is written.

use sqlx::Row;
use time::Duration;

use crate::HrError;
use crate::directory::read_export::{csv_field, optional_row_text, push_csv_row};
use crate::register_facts::exit_reason::exit_reason_code_sql;
use console_hr_domain::profile::mask::RevealField;
use console_hr_domain::register::{CAREER_NONE, exit_reason_label, sex_label};
use console_hr_domain::text::parse_yyyy_mm_dd;

/// Which columns an employee export writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportLayout {
    /// The directory columns (`employees-standard.csv`).
    Standard,
    /// The 근로자 명부 columns, in 별지 제16호서식 order.
    Register,
}

const REGISTER_HEADER: &str = "사번,성명,성별,생년월일,주소,전화번호,사업장,소속,종사 업무,고용일,갱신일,계약기간,마지막 근무일,퇴직일,퇴직(해고) 사유,이력,그 밖에 필요한 사항\r\n";

/// The register's row source; the correlated reads use the list's `e`, `p`
/// and `ea`. 사업장 is the assigned workplace's name today (E-S3a), else the
/// imported worksite text; `workplace_id=` cuts one 사업장's register.
pub(crate) const REGISTER_SELECT: &str = concat!(
    "SELECT e.employee_number, e.name, e.birth_date::TEXT AS birth_date, \
    CASE WHEN console_employee_facts(e.org_id,e.id) ? 'phone' THEN console_employee_facts(e.org_id,e.id)->>'phone' ELSE p.phone_e164 END AS phone_e164, \
    COALESCE( \
      (SELECT w.name FROM workplace_revisions w \
        WHERE w.org_id = e.org_id AND w.workplace_id = ea.workplace_id \
          AND w.effective_from <= (now() AT TIME ZONE 'Asia/Seoul')::date \
        ORDER BY w.effective_from DESC, w.version DESC LIMIT 1), \
      e.worksite_name) AS worksite_name, \
    e.org_unit, e.job, to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date, \
    (SELECT max(r.effective_date) FROM employee_lifecycle_events r \
      WHERE r.org_id = e.org_id AND r.employee_id = e.id \
        AND r.event_type = 'CONTRACT_RENEWAL' AND r.state = 'APPLIED' \
        AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id = r.org_id \
          AND v.voids_event_id = r.id AND v.state = 'APPLIED')) AS renewed_on, \
    COALESCE( \
      (SELECT c.start_date::TEXT || '~' || COALESCE(c.end_date::TEXT, '') \
         FROM employee_contracts c \
        WHERE c.org_id = e.org_id AND c.employee_id = e.id \
          AND NOT EXISTS (SELECT 1 FROM employee_contracts s \
                           WHERE s.org_id = c.org_id AND s.supersedes_id = c.id) \
        ORDER BY c.start_date DESC, c.created_at DESC LIMIT 1), \
      CASE WHEN p.contract_start_date IS NOT NULL OR p.contract_end_date IS NOT NULL \
           THEN COALESCE(p.contract_start_date::TEXT, '') || '~' || COALESCE(p.contract_end_date::TEXT, '') END \
    ) AS contract_term, \
    to_char(e.exit_on, 'YYYY-MM-DD') AS exit_date, \
    (SELECT f.sex FROM employee_register_facts f WHERE f.org_id = e.org_id AND f.employee_id = e.id) AS sex, \
    (SELECT f.career_none FROM employee_register_facts f WHERE f.org_id = e.org_id AND f.employee_id = e.id) AS career_none, \
    ",
    exit_reason_code_sql!(),
    " AS exit_reason_code, \
    (SELECT f.register_note FROM employee_register_facts f WHERE f.org_id = e.org_id AND f.employee_id = e.id) AS register_note, \
    (SELECT a.road_addr_part1 || COALESCE(', ' || a.detail, '') || COALESCE(' ' || a.road_addr_part2, '') \
       FROM employee_register_facts f \
       JOIN employee_addresses a ON a.org_id = f.org_id AND a.id = f.address_id \
      WHERE f.org_id = e.org_id AND f.employee_id = e.id) AS address_line, \
    (SELECT string_agg(concat_ws(' ', c.employer_name, \
              to_char(c.from_month, 'YYYY-MM') || '~' || COALESCE(to_char(c.to_month, 'YYYY-MM'), ''), \
              c.position, c.duty), '; ' ORDER BY c.seq) \
       FROM employee_careers c \
      WHERE c.org_id = e.org_id AND c.employee_id = e.id AND c.voided_at IS NULL) AS careers_line, \
    (SELECT r.label_ko FROM reason_codes r \
      WHERE r.org_id = e.org_id AND r.domain = 'exit_reason' AND r.code = ",
    exit_reason_code_sql!(),
    ") \
      AS exit_reason_tenant_label"
);

/// Each cell's source column or marker (`None` would be an empty cell).
const REGISTER_COLUMNS: [Option<&str>; 17] = [
    Some("employee_number"),
    Some("name"),
    Some(SEX),
    Some("birth_date"),
    Some("address_line"),
    Some("phone_e164"),
    Some("worksite_name"),
    Some("org_unit"),
    Some("job"),
    Some("hire_date"),
    Some("renewed_on"),
    Some("contract_term"),
    Some("exit_date"),
    Some(RETIRED_ON),
    Some(EXIT_REASON),
    Some(CAREERS),
    Some("register_note"),
];

/// Markers for the cells written from a code or a flag.
const SEX: &str = "#sex";
const EXIT_REASON: &str = "#exit_reason";
const CAREERS: &str = "#careers";

/// Marker for the derived 퇴직일 column.
const RETIRED_ON: &str = "#retired_on";

/// 퇴직일 = 마지막 근무일 + 1 (decisions #9: `exit_date` is the 마지막 근무일);
/// empty when the stored date is not an ISO date.
pub fn retired_on(last_working_day: &str) -> String {
    parse_yyyy_mm_dd(last_working_day)
        .ok()
        .and_then(|day| day.checked_add(Duration::days(1)))
        .map(|day| day.to_string())
        .unwrap_or_default()
}

impl ExportLayout {
    pub fn parse(raw: Option<&str>) -> Result<Self, HrError> {
        match raw.map(str::trim).filter(|raw| !raw.is_empty()) {
            None | Some("standard") => Ok(Self::Standard),
            Some("register") => Ok(Self::Register),
            Some(_) => Err(HrError::validation("layout must be standard or register")),
        }
    }

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Standard => crate::directory::read_export::EMPLOYEE_EXPORT_FILE_NAME,
            Self::Register => "employees-register.csv",
        }
    }

    pub fn header(self) -> &'static str {
        match self {
            Self::Standard => crate::directory::read_export::CSV_HEADER,
            Self::Register => REGISTER_HEADER,
        }
    }

    pub fn select(self) -> &'static str {
        match self {
            Self::Standard => crate::directory::read_export::EXPORT_SELECT,
            Self::Register => REGISTER_SELECT,
        }
    }

    pub fn push_row(self, csv: &mut String, row: &sqlx::postgres::PgRow) -> Result<(), HrError> {
        if self == Self::Standard {
            return push_csv_row(csv, row);
        }
        for (index, value) in register_cells(row, false)?.iter().enumerate() {
            if index > 0 {
                csv.push(',');
            }
            csv.push_str(&csv_field(value));
        }
        csv.push_str("\r\n");
        Ok(())
    }
}

/// Canonical register cells shared by CSV, the screen, XLSX and PDF.
pub(crate) fn register_cells(
    row: &sqlx::postgres::PgRow,
    masked: bool,
) -> Result<Vec<String>, HrError> {
    REGISTER_COLUMNS
        .iter()
        .map(|column| {
            let value = match column {
                None => String::new(),
                Some(RETIRED_ON) => retired_on(
                    &row.try_get::<Option<String>, _>("exit_date")?
                        .unwrap_or_default(),
                ),
                Some(SEX) => sex_label(&optional_row_text(row, "sex")?).to_owned(),
                Some(EXIT_REASON) => {
                    let code = optional_row_text(row, "exit_reason_code")?;
                    exit_reason_label(&code)
                        .map(str::to_owned)
                        .unwrap_or(optional_row_text(row, "exit_reason_tenant_label")?)
                }
                Some(CAREERS) => match row.try_get::<Option<bool>, _>("career_none")? {
                    Some(true) => CAREER_NONE.to_owned(),
                    _ => optional_row_text(row, "careers_line")?,
                },
                Some(key) => optional_row_text(row, key)?,
            };
            Ok(match column.and_then(RevealField::from_column) {
                Some(field) if masked => field.masked(&value),
                _ => value,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn register_header_matches_its_columns_and_dates_derive() {
        assert_eq!(
            REGISTER_HEADER.trim_end().split(',').count(),
            REGISTER_COLUMNS.len()
        );
        assert_eq!(retired_on("2026-12-31"), "2027-01-01");
        assert_eq!(retired_on("2026.12.31"), "");
        assert_eq!(ExportLayout::parse(None).unwrap(), ExportLayout::Standard);
        assert_eq!(
            ExportLayout::parse(Some("register")).unwrap(),
            ExportLayout::Register
        );
        assert!(ExportLayout::parse(Some("payroll")).is_err());
    }
}
