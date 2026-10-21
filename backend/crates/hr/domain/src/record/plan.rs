//! The import-sheet row decision. The adapter loads the facts (who the 사번
//! names, the entry the row targets, the person's live entries) and this
//! decides what the row does. Re-importing the same sheet changes nothing:
//! a row equal to a live entry is UNCHANGED.

use serde::Serialize;
use uuid::Uuid;

use super::{RecordFields, Section};

/// What a sheet row asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowIntent {
    /// No `entry_id`: a new entry (or, for 병역, the live one).
    Create(RecordFields),
    /// `entry_id` with values: a correction of that entry.
    Update {
        entry_id: Uuid,
        expected_version: Option<i64>,
        fields: RecordFields,
    },
    /// `entry_id` with a `void_reason`.
    Void {
        entry_id: Uuid,
        expected_version: Option<i64>,
    },
}

/// One live or voided entry as the adapter read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryFact {
    pub entry_id: Uuid,
    pub person_id: Uuid,
    pub section: Section,
    pub version: i64,
    pub voided: bool,
    pub fields: RecordFields,
}

/// The decision for one row. `Error` carries a stable row code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Decision {
    Create,
    Update { entry_id: Uuid, version: i64 },
    Void { entry_id: Uuid, version: i64 },
    Unchanged { entry_id: Uuid },
    Error { code: &'static str },
}

/// Decide one row for `person_id` in `section`.
///
/// `target` is the entry named by the row's `entry_id` (`None` when absent or
/// not visible); `live` are the person's live entries of this section.
#[must_use]
pub fn decide(
    section: Section,
    person_id: Uuid,
    intent: &RowIntent,
    target: Option<&EntryFact>,
    live: &[EntryFact],
) -> Decision {
    match intent {
        RowIntent::Create(fields) => {
            if let Some(same) = live.iter().find(|e| &e.fields == fields) {
                return Decision::Unchanged {
                    entry_id: same.entry_id,
                };
            }
            match live.first() {
                Some(only) if section.single_live() => Decision::Update {
                    entry_id: only.entry_id,
                    version: only.version,
                },
                _ => Decision::Create,
            }
        }
        RowIntent::Update {
            expected_version,
            fields,
            ..
        } => match checked(section, person_id, target, *expected_version) {
            Err(code) => Decision::Error { code },
            Ok(entry) if entry.voided => Decision::Error {
                code: "entry_voided",
            },
            Ok(entry) if &entry.fields == fields => Decision::Unchanged {
                entry_id: entry.entry_id,
            },
            Ok(entry) => Decision::Update {
                entry_id: entry.entry_id,
                version: entry.version,
            },
        },
        RowIntent::Void {
            expected_version, ..
        } => match checked(section, person_id, target, *expected_version) {
            Err(code) => Decision::Error { code },
            Ok(entry) if entry.voided => Decision::Unchanged {
                entry_id: entry.entry_id,
            },
            Ok(entry) => Decision::Void {
                entry_id: entry.entry_id,
                version: entry.version,
            },
        },
    }
}

fn checked(
    section: Section,
    person_id: Uuid,
    target: Option<&EntryFact>,
    expected_version: Option<i64>,
) -> Result<&EntryFact, &'static str> {
    let entry = target
        .filter(|e| e.person_id == person_id && e.section == section)
        .ok_or("entry_not_found")?;
    if expected_version.is_some_and(|v| v != entry.version) {
        return Err("version_conflict");
    }
    Ok(entry)
}
