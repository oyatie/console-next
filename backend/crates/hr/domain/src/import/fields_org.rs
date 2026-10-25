// SPDX-License-Identifier: LicenseRef-Proprietary
/// The organization importer uses the same statutory target aliases as people import.
#[must_use]
pub fn aliases() -> std::collections::BTreeMap<&'static str, &'static [&'static str]> {
    super::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .filter(|field| {
            matches!(
                field.target,
                "company" | "company_brn" | "workplace" | "org_unit"
            )
        })
        .map(|field| (field.target, field.aliases))
        .chain([
            (
                "parent",
                &[
                    "상위부서",
                    "상위조직",
                    "상위부서명",
                    "parent",
                    "parent department",
                    "parent unit",
                ][..],
            ),
            (
                "code",
                &[
                    "부서코드",
                    "조직코드",
                    "코드",
                    "department code",
                    "org code",
                    "code",
                ][..],
            ),
            (
                "head",
                &[
                    "팀장사번",
                    "부서장사번",
                    "부서장",
                    "팀장",
                    "사번",
                    "head employee number",
                    "team lead number",
                    "head",
                    "team lead",
                    "employee number",
                ][..],
            ),
            (
                "shift",
                &[
                    "교대",
                    "교대조",
                    "근무조",
                    "shift",
                    "shift team",
                    "work shift",
                ][..],
            ),
        ])
        .collect()
}

#[cfg(test)]
mod generated_aliases {
    #![allow(clippy::unwrap_used)]
    #[test]
    fn organization_aliases_match_the_generated_client_table() {
        let expected = serde_json::json!({
            "_license": "SPDX-License-Identifier: LicenseRef-Proprietary",
            "_generated_by": "console-hr-domain example import_aliases; edit import/fields.rs or fields_org.rs",
            "aliases": super::aliases(),
        });
        let actual: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../apps/web/src/reference/import/aliases.json"
        ))
        .unwrap();
        assert_eq!(actual, expected);
    }
}
