// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::path::Path;

use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::incident::{IncidentEvent, IncidentRefusal, IncidentState};
use console_ops_application::incidents::{IncidentError, IncidentStore};
use console_ops_application::obligations::{Context, Error as SpoolError};
use console_ops_application::time::OffsetDateTime;
use console_ops_application::time::format_description::well_known::Rfc3339;
use serde_json::{Map, Value, json};

use crate::{AppendError, Record, RecordSpool, SpoolError as FsSpoolError, SpoolPrefix};

fn map_spool(err: FsSpoolError) -> IncidentError {
    match err {
        FsSpoolError::ChainBroken(seq) => IncidentError::Spool(SpoolError::ChainBroken(seq)),
        FsSpoolError::Unreadable => IncidentError::Spool(SpoolError::Unreadable),
        FsSpoolError::WriteFailed => IncidentError::Spool(SpoolError::WriteFailed),
    }
}

pub struct FsIncidentStore {
    spool: RecordSpool,
}

impl FsIncidentStore {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            spool: RecordSpool::open_resilient_prefix(records_dir, SpoolPrefix::Incidents),
        }
    }

    pub fn spool(&self) -> &RecordSpool {
        &self.spool
    }
}

fn replay(records: &[Record]) -> Result<Vec<IncidentState>, IncidentError> {
    let mut map: BTreeMap<String, IncidentState> = BTreeMap::new();
    for rec in records {
        let seq = rec.document["seq"]
            .as_u64()
            .ok_or(IncidentError::Spool(SpoolError::ChainBroken(0)))?;
        let at_raw = rec.document["at"]
            .as_str()
            .ok_or(IncidentError::Spool(SpoolError::ChainBroken(seq)))?;
        if !at_raw.ends_with('Z') {
            return Err(IncidentError::Spool(SpoolError::ChainBroken(seq)));
        }
        let at = OffsetDateTime::parse(at_raw, &Rfc3339)
            .map_err(|_| IncidentError::Spool(SpoolError::ChainBroken(seq)))?;
        let actor = rec.document["operator"]["person"]
            .as_str()
            .ok_or(IncidentError::Spool(SpoolError::ChainBroken(seq)))?;
        let incident_id = rec.document["incident_id"]
            .as_str()
            .ok_or(IncidentError::Spool(SpoolError::ChainBroken(seq)))?;
        let event: IncidentEvent = serde_json::from_value(json!({
            "event": rec.document["event"],
            "fields": rec.document["fields"],
        }))
        .map_err(|_| IncidentError::Spool(SpoolError::ChainBroken(seq)))?;

        let current = map.get(incident_id);
        let next = IncidentState::evolve(
            current,
            incident_id,
            &event,
            seq,
            &rec.hash,
            at,
            actor,
            None,
        )
        .map_err(|_| IncidentError::Spool(SpoolError::ChainBroken(seq)))?;
        map.insert(incident_id.to_owned(), next);
    }
    Ok(map.into_values().collect())
}

fn build_record_doc(
    incident_id: &str,
    event: &IncidentEvent,
    context: &Context,
) -> Result<Map<String, Value>, IncidentError> {
    let event_val =
        serde_json::to_value(event).map_err(|_| IncidentError::Domain(IncidentRefusal::Invalid))?;
    let mut doc = Map::new();
    doc.insert(
        "at".to_owned(),
        serde_json::to_value(UtcTimestamp::new(context.at))
            .map_err(|_| IncidentError::Domain(IncidentRefusal::Invalid))?,
    );
    doc.insert(
        "operator".to_owned(),
        serde_json::to_value(&context.operator)
            .map_err(|_| IncidentError::Domain(IncidentRefusal::Invalid))?,
    );
    doc.insert(
        "incident_id".to_owned(),
        Value::String(incident_id.to_owned()),
    );
    doc.insert("event".to_owned(), event_val["event"].clone());
    doc.insert("fields".to_owned(), event_val["fields"].clone());
    Ok(doc)
}

impl IncidentStore for FsIncidentStore {
    fn list(&self) -> Result<Vec<IncidentState>, IncidentError> {
        let records = self.spool.read().map_err(map_spool)?;
        replay(&records)
    }

    fn get(&self, id: &str) -> Result<IncidentState, IncidentError> {
        self.list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or(IncidentError::Domain(IncidentRefusal::NotFound))
    }

    fn declare(
        &self,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        let rec = self
            .spool
            .append(&context.support_ref, |records| {
                let items = replay(records)?;
                let next_num = items.len() + 1;
                let id = format!("INC-{next_num:04}");
                let seq = records.len() as u64 + 1;
                IncidentState::evolve(
                    None,
                    &id,
                    &event,
                    seq,
                    "",
                    context.at,
                    &context.operator.person,
                    Some(0),
                )
                .map_err(IncidentError::Domain)?;
                build_record_doc(&id, &event, context)
            })
            .map_err(|err| match err {
                AppendError::Storage(s) => map_spool(s),
                AppendError::Rejected(e) => e,
            })?;
        let id = rec.document["incident_id"]
            .as_str()
            .ok_or(IncidentError::Spool(SpoolError::WriteFailed))?;
        self.get(id)
    }

    fn mutate(
        &self,
        id: &str,
        expected_seq: u64,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        self.spool
            .append(&context.support_ref, |records| {
                let items = replay(records)?;
                let current = items.iter().find(|i| i.id == id);
                let seq = records.len() as u64 + 1;
                IncidentState::evolve(
                    current,
                    id,
                    &event,
                    seq,
                    "",
                    context.at,
                    &context.operator.person,
                    Some(expected_seq),
                )
                .map_err(IncidentError::Domain)?;
                build_record_doc(id, &event, context)
            })
            .map_err(|err| match err {
                AppendError::Storage(s) => map_spool(s),
                AppendError::Rejected(e) => e,
            })?;
        self.get(id)
    }
}
