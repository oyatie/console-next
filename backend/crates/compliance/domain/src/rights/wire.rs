// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::statutory::{Citation, ReleaseDisposition, StatutoryRule, StatutoryUnit};
use serde::{Serialize, Serializer};

pub(super) fn rule<S: Serializer>(
    rule: &Option<StatutoryRule>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    #[derive(Serialize)]
    struct Rule<'a> {
        code: &'a str,
        effective_from: String,
        effective_to_exclusive: Option<String>,
        unit: StatutoryUnit,
        value_num: i64,
        value_den: i64,
        citation: &'a Citation,
        disposition: &'a ReleaseDisposition,
    }

    rule.as_ref()
        .map(|rule| Rule {
            code: &rule.code,
            effective_from: rule.effective_from.to_string(),
            effective_to_exclusive: rule.effective_to_exclusive.map(|date| date.to_string()),
            unit: rule.unit,
            value_num: rule.value_num,
            value_den: rule.value_den,
            citation: &rule.citation,
            disposition: &rule.disposition,
        })
        .serialize(serializer)
}
