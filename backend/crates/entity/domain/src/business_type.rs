//! 업태 · 종목 as printed on a 사업자등록증, with an optional KSIC code.

use serde::{Deserialize, Serialize};

use crate::legal_entity::{CodeInput, CodeRef, code_ref};
use crate::refusal::{INVALID_OPTION, Issues, OUT_OF_RANGE, REQUIRED};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BusinessTypeInput {
    pub is_main: Option<bool>,
    pub sector: Option<String>,
    pub item: Option<String>,
    pub nts_code: Option<String>,
    pub ksic: Option<CodeInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BusinessType {
    pub is_main: bool,
    pub sector_as_printed: String,
    pub item_as_printed: String,
    pub nts_code: Option<String>,
    pub ksic: Option<CodeRef>,
}

pub(crate) fn business_types(is: &mut Issues, raw: &[BusinessTypeInput]) -> Vec<BusinessType> {
    if raw.is_empty() {
        is.push("business_types", REQUIRED);
        return Vec::new();
    }
    if raw.len() > 50 {
        is.push("business_types", OUT_OF_RANGE);
        return Vec::new();
    }
    if raw.iter().filter(|t| t.is_main == Some(true)).count() != 1 {
        is.push("business_types", "exactly_one_main");
    }
    raw.iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let p = |f: &str| format!("business_types[{i}].{f}");
            let sector = is.text(&p("sector"), t.sector.as_deref(), 100, true);
            let item = is.text(&p("item"), t.item.as_deref(), 200, true);
            let nts_code = t
                .nts_code
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty());
            if nts_code.is_some_and(|c| c.len() != 6 || !c.bytes().all(|b| b.is_ascii_digit())) {
                is.push(p("nts_code"), INVALID_OPTION);
            }
            let ksic = t
                .ksic
                .as_ref()
                .and_then(|k| code_ref(is, &p("ksic"), k, item.as_deref()));
            Some(BusinessType {
                is_main: t.is_main == Some(true),
                sector_as_printed: sector?,
                item_as_printed: item?,
                nts_code: nts_code.map(str::to_owned),
                ksic,
            })
        })
        .collect()
}
