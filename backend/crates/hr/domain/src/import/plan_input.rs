//! Workbook source values and explicit review decisions.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// One candidate row as the workbook gave it (cells trimmed, empty = None).
#[derive(Debug, Clone, Default)]
pub struct ImportRow {
    pub source_key: String,
    pub sheet: String,
    pub row: i32,
    pub name: String,
    pub company: String,
    pub company_brn: Option<String>,
    pub employee_number: Option<String>,
    pub hire_date: Option<String>,
    pub exit_date: Option<String>,
    pub birth_date: Option<String>,
    pub org_unit: Option<String>,
    pub job: Option<String>,
    pub position: Option<String>,
    pub workplace: Option<String>,
    pub worksite_name: Option<String>,
    pub worksite_address: Option<String>,
    /// 고용형태 as the file wrote it (a code or a label the operator maps).
    pub employment_type: Option<String>,
    /// IMPORT-2: 재직상태, 휴직 시작일 and 휴직 유형 as the file wrote them.
    pub status: Option<String>,
    pub leave_start_date: Option<String>,
    pub leave_type: Option<String>,
    /// 복직 예정일 (required for 육아휴직 and 출산전후휴가).
    pub leave_return_date: Option<String>,
    /// IMPORT-2: the keyed hash of the row's 주민등록번호 (never the number).
    pub rrn_hmac: Option<Vec<u8>>,
    /// W12: the row has a 휴대전화 (the number stays in the stored row).
    pub has_phone: bool,
    /// r3:hire-16: `MALE` / `FEMALE` from the 성별 column or the 주민등록번호.
    pub sex: Option<String>,
    /// r3:hire-16: 계약종료일 and 수습종료일 as the file wrote them.
    pub contract_end_date: Option<String>,
    pub probation_end_date: Option<String>,
}

/// The operator's choice for a row without a 사번 that resembles people on
/// file: one of them (`employee_id`), or a new person (`null`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityPick {
    pub employee_id: Option<Uuid>,
}

/// A row left out of the import (BW-07 domain `import_exclude`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exclusion {
    pub reason_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What the operator decided on the dry run; stored with the run, so the
/// apply re-plans with exactly these.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decisions {
    /// Imported company alias → a certificate-confirmed entity's primary workplace, or unresolved.
    #[serde(default)]
    pub company_map: BTreeMap<String, Option<Uuid>>,
    /// Unit name in the file → an ACTIVE unit id, or `null`: 미배치 (no
    /// unit). An unknown name the operator did not answer is 미배치 too.
    #[serde(default)]
    pub unit_map: BTreeMap<String, Option<Uuid>>,
    /// 사업장 text in the file → an open 사업장 id, or `null`: not a 사업장
    /// (a 현장 name), so it places nobody.
    #[serde(default)]
    pub workplace_map: BTreeMap<String, Option<Uuid>>,
    /// 고용형태 text in the file → an employment type code, or `null`: leave
    /// it empty (정보 미입력). The codes themselves map without an answer.
    #[serde(default)]
    pub employment_type_map: BTreeMap<String, Option<String>>,
    /// `source_key` → the person a row without a 사번 is.
    #[serde(default)]
    pub identity: BTreeMap<String, IdentityPick>,
    /// `source_key` → why the row is left out.
    #[serde(default)]
    pub exclusions: BTreeMap<String, Exclusion>,
    /// IMPORT-2: 재직상태 text → status code (`ACTIVE`, `ON_LEAVE`, ...).
    #[serde(default)]
    pub status_map: BTreeMap<String, String>,
    /// IMPORT-2: 휴직 유형 text (`""` when the cell is empty) → leave type.
    #[serde(default)]
    pub leave_type_map: BTreeMap<String, String>,
    /// IMPORT-2: `source_key` → the 사번 the operator gives a row without one.
    #[serde(default)]
    pub employee_numbers: BTreeMap<String, String>,
    /// W05: `reason` or `reason:field` → why every such row is left out
    /// (`plan_group`). A row's own `exclusions` entry wins.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_exclusions: BTreeMap<String, Exclusion>,
    /// r3:hire-19: one answer for a conflict pattern, never row by row —
    /// `workplace_conflict` → `follow_unit` (the 부서's 사업장) or
    /// `follow_workplace` (the 근무지, the 부서 left 미배치); `status_conflict`
    /// → `pre_hire` (재직 with a future 입사일 comes in 입사 예정).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_answers: BTreeMap<String, String>,
}
