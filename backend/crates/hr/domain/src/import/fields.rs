// SPDX-License-Identifier: LicenseRef-Proprietary
//! Versioned employee import metadata, loaded once from the declared catalogue.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmployeeImportFieldDefinition<'a> {
    #[serde(borrow)]
    pub target: &'a str,
    #[serde(borrow)]
    pub aliases: Vec<&'a str>,
    pub classification: &'a str,
    pub required: bool,
    pub label_ids: LabelIds,
    pub value_type: ValueType,
    pub format: ValueFormat,
    pub code_catalogue: Option<CodeCatalogue>,
    pub example: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LabelIds {
    pub ko: String,
    pub en: String,
}

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Text,
    Date,
    Decimal,
    Code,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueFormat {
    Text,
    IsoDate,
    DecimalDays,
    DecimalHours,
    CatalogueLabel,
    E164,
    BusinessRegistrationNumber,
    ResidentRegistrationNumber,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum CodeCatalogue {
    Refdata {
        resource: String,
    },
    Tenant {
        resource: String,
        kind: Option<String>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmployeeImportCatalogue<'a> {
    #[serde(rename = "_license", skip_serializing)]
    _license: String,
    pub object: String,
    #[serde(skip_deserializing)]
    pub version: String,
    #[serde(borrow)]
    pub fields: Vec<EmployeeImportFieldDefinition<'a>>,
}

impl<'a> EmployeeImportCatalogue<'a> {
    fn parse(source: &'a str) -> Result<Self, serde_json::Error> {
        let mut catalogue: Self = serde_json::from_str(source)?;
        let hash: String = Sha256::digest(source.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        catalogue.version = format!("sha256:{hash}");
        Ok(catalogue)
    }
}

static CATALOGUE: LazyLock<EmployeeImportCatalogue<'static>> = LazyLock::new(|| {
    // A corrupt built-in catalogue must fail closed; contract tests validate this embedded data.
    #[expect(clippy::expect_used)]
    EmployeeImportCatalogue::parse(include_str!("../../data/employee.json"))
        .expect("embedded employee catalogue must match its typed schema")
});

#[must_use]
pub fn employee_import_catalogue() -> &'static EmployeeImportCatalogue<'static> {
    &CATALOGUE
}

/// Compatibility view used by the importer and its existing preview target options.
pub static EMPLOYEE_IMPORT_FIELD_DEFINITIONS: LazyLock<
    &'static [EmployeeImportFieldDefinition<'static>],
> = LazyLock::new(|| &employee_import_catalogue().fields);

#[cfg(test)]
#[path = "fields_tests.rs"]
mod tests;
