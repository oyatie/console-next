//! The `settings_snapshot jsonb` every exception, unlock, event and decision
//! row stores: the values it was decided under and where each came from.

use crate::{SettingKey, SettingValue};
use console_kernel_core::{Resolved, SettingVersionId};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SnapshotEntry {
    pub value: SettingValue,
    pub version: SettingVersionId,
}

/// Serializes as `{"<key>": {"value": …, "version": …}, …}`, keys in roster
/// order, so the same inputs always produce the same bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SettingsSnapshot(BTreeMap<SettingKey, SnapshotEntry>);

impl SettingsSnapshot {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a resolved value; returns the value for the caller to use.
    pub fn record(&mut self, key: SettingKey, resolved: Resolved<SettingValue>) -> SettingValue {
        self.0.insert(
            key,
            SnapshotEntry {
                value: resolved.value,
                version: resolved.version,
            },
        );
        resolved.value
    }

    #[must_use]
    pub fn get(&self, key: SettingKey) -> Option<SnapshotEntry> {
        self.0.get(&key).copied()
    }

    /// The jsonb value to store on the decision row.
    ///
    /// # Errors
    /// Only if serde_json rejects the map, which string keys rule out.
    pub fn to_json(&self) -> Result<serde_json::Value, serde_json::Error> {
        serde_json::to_value(self)
    }
}
