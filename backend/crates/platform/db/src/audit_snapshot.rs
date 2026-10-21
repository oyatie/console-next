//! Versions of defaults and target ancestry; personal setting values never persist.
use crate::DbError;
use console_kernel_core::OrgId;
use console_settings_domain::SettingKey;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::{collections::BTreeMap, sync::OnceLock};
use uuid::Uuid;

pub(crate) fn default_versions() -> &'static BTreeMap<String, Value> {
    static DEFAULTS: OnceLock<BTreeMap<String, Value>> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        SettingKey::ALL
            .iter()
            .filter_map(|key| {
                key.def().default.map(|value| {
                    let version = format!(
                        "sha256:{}",
                        hex::encode(Sha256::digest(
                            serde_json::json!(value).to_string().as_bytes()
                        ))
                    );
                    (key.as_str().to_owned(), Value::String(version))
                })
            })
            .collect()
    })
}

pub(crate) async fn admission(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    scopes: &[Uuid],
) -> Result<(Option<String>, Vec<Uuid>, BTreeMap<String, Value>), DbError> {
    let (phase, parents, versions): (
        Option<String>,
        Vec<Uuid>,
        sqlx::types::Json<BTreeMap<String, Value>>,
    ) = sqlx::query_as("SELECT phase,parent_scopes,versions FROM audit_admission_snapshot($1,$2)")
        .bind(org.as_uuid())
        .bind(scopes)
        .fetch_one(tx.as_mut())
        .await?;
    Ok((phase, parents, versions.0))
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_versions_are_stable_digests_without_values() {
        let versions = super::default_versions();
        assert!(!versions.is_empty());
        for version in versions.values() {
            let Some(version) = version.as_str() else {
                panic!("version is not a string")
            };
            assert!(version.starts_with("sha256:"));
            assert_eq!(version.len(), 71);
        }
        assert_eq!(versions, super::default_versions());
    }
}
