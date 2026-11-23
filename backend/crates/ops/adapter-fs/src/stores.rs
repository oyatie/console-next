// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::Path;

use console_ops_application::alert_actions::{
    AlertAckRecord, AlertAckStore, SilenceAuditRecord, SilenceAuditStore,
};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::obligations::{Context, Error as SpoolError};
use console_ops_application::time::OffsetDateTime;
use console_ops_application::time::format_description::well_known::Rfc3339;
use serde_json::{Map, Value};

use crate::{AppendError, Record, RecordSpool, SpoolError as FsSpoolError, SpoolPrefix};

pub(crate) fn map_spool_err(err: FsSpoolError) -> SpoolError {
    match err {
        FsSpoolError::ChainBroken(seq) => SpoolError::ChainBroken(seq),
        FsSpoolError::Unreadable => SpoolError::Unreadable,
        FsSpoolError::WriteFailed => SpoolError::WriteFailed,
    }
}

pub(crate) fn map_append_err(err: AppendError<SpoolError>) -> SpoolError {
    match err {
        AppendError::Storage(s) => map_spool_err(s),
        AppendError::Rejected(e) => e,
    }
}

fn parse_utc_at(doc: &Value, seq: u64) -> Result<UtcTimestamp, SpoolError> {
    let raw = doc["at"].as_str().ok_or(SpoolError::ChainBroken(seq))?;
    if !raw.ends_with('Z') {
        return Err(SpoolError::ChainBroken(seq));
    }
    OffsetDateTime::parse(raw, &Rfc3339)
        .map(UtcTimestamp::new)
        .map_err(|_| SpoolError::ChainBroken(seq))
}

pub(crate) fn common_fields(context: &Context) -> Map<String, Value> {
    let mut map = Map::new();
    let at_val = serde_json::to_value(UtcTimestamp::new(context.at)).unwrap_or(Value::Null);
    map.insert("at".to_owned(), at_val);
    map.insert(
        "operator".to_owned(),
        serde_json::to_value(&context.operator).unwrap_or(Value::Null),
    );
    map
}

pub(crate) fn record_meta(rec: &Record) -> Result<(u64, UtcTimestamp, String, String), SpoolError> {
    let seq = rec.document["seq"]
        .as_u64()
        .ok_or(SpoolError::ChainBroken(0))?;
    let at = parse_utc_at(&rec.document, seq)?;
    let support_ref = rec.document["support_ref"]
        .as_str()
        .ok_or(SpoolError::ChainBroken(seq))?
        .to_owned();
    let operator = rec.document["operator"]["person"]
        .as_str()
        .ok_or(SpoolError::ChainBroken(seq))?
        .to_owned();
    Ok((seq, at, support_ref, operator))
}

pub struct FsAlertAckStore {
    spool: RecordSpool,
}

impl FsAlertAckStore {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            spool: RecordSpool::open_resilient_prefix(records_dir, SpoolPrefix::Alerts),
        }
    }

    pub fn spool(&self) -> &RecordSpool {
        &self.spool
    }
}

impl AlertAckStore for FsAlertAckStore {
    fn list_acks(&self) -> Result<Vec<AlertAckRecord>, SpoolError> {
        let records = self.spool.read().map_err(map_spool_err)?;
        records
            .iter()
            .map(|r| {
                let (seq, at, support_ref, operator) = record_meta(r)?;
                Ok(AlertAckRecord {
                    seq,
                    hash: r.hash.clone(),
                    support_ref,
                    at,
                    operator,
                    group_key: r.document["group_key"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    alertname: r.document["alertname"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    component: r.document["component"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    note: r.document["note"].as_str().map(str::to_owned),
                })
            })
            .collect()
    }

    fn record_ack(
        &self,
        group_key: &str,
        alertname: &str,
        component: &str,
        note: Option<String>,
        context: &Context,
    ) -> Result<AlertAckRecord, SpoolError> {
        let rec = self
            .spool
            .append(&context.support_ref, |_| {
                let mut doc = common_fields(context);
                doc.insert("event".to_owned(), Value::String("alert_ack".to_owned()));
                doc.insert("group_key".to_owned(), Value::String(group_key.to_owned()));
                doc.insert("alertname".to_owned(), Value::String(alertname.to_owned()));
                doc.insert("component".to_owned(), Value::String(component.to_owned()));
                if let Some(n) = &note {
                    doc.insert("note".to_owned(), Value::String(n.clone()));
                }
                Ok::<_, SpoolError>(doc)
            })
            .map_err(map_append_err)?;
        let (seq, at, support_ref, operator) = record_meta(&rec)?;
        Ok(AlertAckRecord {
            seq,
            hash: rec.hash,
            support_ref,
            at,
            operator,
            group_key: group_key.to_owned(),
            alertname: alertname.to_owned(),
            component: component.to_owned(),
            note,
        })
    }
}

pub struct FsSilenceSpool {
    spool: RecordSpool,
}

impl FsSilenceSpool {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            spool: RecordSpool::open_resilient_prefix(records_dir, SpoolPrefix::Silences),
        }
    }

    pub fn spool(&self) -> &RecordSpool {
        &self.spool
    }
}

impl SilenceAuditStore for FsSilenceSpool {
    fn list_records(&self) -> Result<Vec<SilenceAuditRecord>, SpoolError> {
        let records = self.spool.read().map_err(map_spool_err)?;
        records
            .iter()
            .map(|r| {
                let (seq, at, support_ref, operator) = record_meta(r)?;
                Ok(SilenceAuditRecord {
                    seq,
                    hash: r.hash.clone(),
                    support_ref,
                    at,
                    operator,
                    action: r.document["event"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    silence_id: r.document["silence_id"].as_str().map(str::to_owned),
                    group_key: r.document["group_key"].as_str().map(str::to_owned),
                    detail: r.document["detail"].as_str().map(str::to_owned),
                })
            })
            .collect()
    }

    fn record_event(
        &self,
        action: &str,
        silence_id: Option<&str>,
        group_key: Option<&str>,
        detail: Option<&str>,
        context: &Context,
    ) -> Result<SilenceAuditRecord, SpoolError> {
        let rec = self
            .spool
            .append(&context.support_ref, |_| {
                let mut doc = common_fields(context);
                doc.insert("event".to_owned(), Value::String(action.to_owned()));
                if let Some(id) = silence_id {
                    doc.insert("silence_id".to_owned(), Value::String(id.to_owned()));
                }
                if let Some(gk) = group_key {
                    doc.insert("group_key".to_owned(), Value::String(gk.to_owned()));
                }
                if let Some(d) = detail {
                    doc.insert("detail".to_owned(), Value::String(d.to_owned()));
                }
                Ok::<_, SpoolError>(doc)
            })
            .map_err(map_append_err)?;
        let (seq, at, support_ref, operator) = record_meta(&rec)?;
        Ok(SilenceAuditRecord {
            seq,
            hash: rec.hash,
            support_ref,
            at,
            operator,
            action: action.to_owned(),
            silence_id: silence_id.map(str::to_owned),
            group_key: group_key.map(str::to_owned),
            detail: detail.map(str::to_owned),
        })
    }
}
