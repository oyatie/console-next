//! `KrAddress`: a structured Korean address (도로명주소 juso fields, or
//! structured manual entry when the search is unavailable; R3 no dead end).

use serde::{Deserialize, Serialize};

use crate::codes::AddressSource;
use crate::refusal::{INVALID_OPTION, Issues, REQUIRED};

/// What the client sends: either the juso result it picked (all codes), or a
/// structured manual entry (시도 + 시군구 + 도로명 and number typed).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AddressInput {
    pub source: Option<String>,
    pub road_addr_part1: Option<String>,
    pub road_addr_part2: Option<String>,
    pub jibun_addr: Option<String>,
    pub eng_addr: Option<String>,
    pub zip_no: Option<String>,
    pub adm_cd: Option<String>,
    pub rn_mgt_sn: Option<String>,
    pub bd_mgt_sn: Option<String>,
    pub si_nm: Option<String>,
    pub sgg_nm: Option<String>,
    pub emd_nm: Option<String>,
    pub li_nm: Option<String>,
    pub bd_nm: Option<String>,
    pub udrt_yn: Option<bool>,
    pub buld_mnnm: Option<i32>,
    pub buld_slno: Option<i32>,
    pub mt_yn: Option<bool>,
    pub lnbr_mnnm: Option<i32>,
    pub lnbr_slno: Option<i32>,
    pub detail: Option<String>,
    pub as_printed: Option<String>,
}

/// A validated address, ready to store as one immutable row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KrAddress {
    pub source: AddressSource,
    pub road_addr_part1: String,
    pub road_addr_part2: Option<String>,
    pub jibun_addr: Option<String>,
    pub eng_addr: Option<String>,
    pub zip_no: Option<String>,
    pub adm_cd: Option<String>,
    pub rn_mgt_sn: Option<String>,
    pub bd_mgt_sn: Option<String>,
    pub si_nm: String,
    pub sgg_nm: Option<String>,
    pub emd_nm: Option<String>,
    pub li_nm: Option<String>,
    pub bd_nm: Option<String>,
    pub udrt_yn: Option<bool>,
    pub buld_mnnm: Option<i32>,
    pub buld_slno: Option<i32>,
    pub mt_yn: Option<bool>,
    pub lnbr_mnnm: Option<i32>,
    pub lnbr_slno: Option<i32>,
    pub detail: Option<String>,
    pub as_printed: Option<String>,
}

impl KrAddress {
    /// One line for display: `roadAddrPart1, 상세 roadAddrPart2` (juso guide).
    #[must_use]
    pub fn one_line(&self) -> String {
        let mut out = self.road_addr_part1.clone();
        if let Some(detail) = &self.detail {
            out.push_str(", ");
            out.push_str(detail);
        }
        if let Some(part2) = &self.road_addr_part2 {
            out.push(' ');
            out.push_str(part2);
        }
        out
    }
}

fn digits(
    issues: &mut Issues,
    field: &str,
    raw: Option<&str>,
    len: usize,
    required: bool,
) -> Option<String> {
    let value = raw.map(str::trim).filter(|v| !v.is_empty());
    match value {
        None => {
            if required {
                issues.push(field, REQUIRED);
            }
            None
        }
        Some(v) if v.len() == len && v.bytes().all(|b| b.is_ascii_digit()) => Some(v.to_owned()),
        Some(_) => {
            issues.push(field, INVALID_OPTION);
            None
        }
    }
}

/// Validate one address input under `prefix` (e.g. `head_office_address`).
pub fn validate_address(
    issues: &mut Issues,
    prefix: &str,
    input: &AddressInput,
) -> Option<KrAddress> {
    let f = |name: &str| format!("{prefix}.{name}");
    let before = issues_len(issues);
    let source = issues.choice(
        &f("source"),
        input.source.as_deref(),
        true,
        AddressSource::parse,
    );
    let juso = source == Some(AddressSource::Juso);
    let road = issues.text(
        &f("road_addr_part1"),
        input.road_addr_part1.as_deref(),
        200,
        true,
    );
    let si_nm = issues.text(&f("si_nm"), input.si_nm.as_deref(), 40, true);
    // Manual entry still needs the 시군구 the user picked; juso always has it
    // except for 세종 (no 시군구), so it is required only for manual rows.
    let sgg_nm = issues.text(&f("sgg_nm"), input.sgg_nm.as_deref(), 40, !juso);
    let zip_no = digits(issues, &f("zip_no"), input.zip_no.as_deref(), 5, juso);
    let adm_cd = digits(issues, &f("adm_cd"), input.adm_cd.as_deref(), 10, juso);
    let rn_mgt_sn = digits(
        issues,
        &f("rn_mgt_sn"),
        input.rn_mgt_sn.as_deref(),
        12,
        false,
    );
    let bd_mgt_sn = digits(
        issues,
        &f("bd_mgt_sn"),
        input.bd_mgt_sn.as_deref(),
        25,
        juso,
    );
    let address = KrAddress {
        source: source.unwrap_or(AddressSource::ManualUnverified),
        road_addr_part1: road.unwrap_or_default(),
        road_addr_part2: issues.text(
            &f("road_addr_part2"),
            input.road_addr_part2.as_deref(),
            100,
            false,
        ),
        jibun_addr: issues.text(&f("jibun_addr"), input.jibun_addr.as_deref(), 200, false),
        eng_addr: issues.text(&f("eng_addr"), input.eng_addr.as_deref(), 300, false),
        zip_no,
        adm_cd,
        rn_mgt_sn,
        bd_mgt_sn,
        si_nm: si_nm.unwrap_or_default(),
        sgg_nm,
        emd_nm: issues.text(&f("emd_nm"), input.emd_nm.as_deref(), 40, false),
        li_nm: issues.text(&f("li_nm"), input.li_nm.as_deref(), 40, false),
        bd_nm: issues.text(&f("bd_nm"), input.bd_nm.as_deref(), 100, false),
        udrt_yn: input.udrt_yn,
        buld_mnnm: non_negative(issues, &f("buld_mnnm"), input.buld_mnnm),
        buld_slno: non_negative(issues, &f("buld_slno"), input.buld_slno),
        mt_yn: input.mt_yn,
        lnbr_mnnm: non_negative(issues, &f("lnbr_mnnm"), input.lnbr_mnnm),
        lnbr_slno: non_negative(issues, &f("lnbr_slno"), input.lnbr_slno),
        detail: issues.text(&f("detail"), input.detail.as_deref(), 100, false),
        as_printed: issues.text(&f("as_printed"), input.as_printed.as_deref(), 300, false),
    };
    (issues_len(issues) == before).then_some(address)
}

fn non_negative(issues: &mut Issues, field: &str, value: Option<i32>) -> Option<i32> {
    match value {
        Some(v) if v < 0 => {
            issues.push(field, crate::refusal::OUT_OF_RANGE);
            None
        }
        other => other,
    }
}

fn issues_len(issues: &Issues) -> usize {
    issues.count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual() -> AddressInput {
        AddressInput {
            source: Some("MANUAL_UNVERIFIED".into()),
            road_addr_part1: Some("서울특별시 강남구 테헤란로 152".into()),
            si_nm: Some("서울특별시".into()),
            sgg_nm: Some("강남구".into()),
            detail: Some("12층".into()),
            ..AddressInput::default()
        }
    }

    #[test]
    fn manual_entry_needs_si_sgg_and_road() {
        let mut issues = Issues::default();
        let address = validate_address(&mut issues, "a", &manual()).unwrap();
        assert_eq!(address.one_line(), "서울특별시 강남구 테헤란로 152, 12층");
        let mut issues = Issues::default();
        let missing = AddressInput {
            sgg_nm: None,
            ..manual()
        };
        assert!(validate_address(&mut issues, "a", &missing).is_none());
        assert_eq!(issues.into_vec()[0].field, "a.sgg_nm");
    }

    #[test]
    fn juso_rows_need_their_codes() {
        let mut issues = Issues::default();
        let juso = AddressInput {
            source: Some("JUSO".into()),
            ..manual()
        };
        assert!(validate_address(&mut issues, "a", &juso).is_none());
        let fields: Vec<String> = issues.into_vec().into_iter().map(|i| i.field).collect();
        assert_eq!(fields, vec!["a.zip_no", "a.adm_cd", "a.bd_mgt_sn"]);
    }
}
