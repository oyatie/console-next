// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_application::obligations::{Context, Entry, Error, Record, RecordSpool};
use serde_json::json;

use crate::{AppendError, SpoolError};

fn storage(error: SpoolError) -> Error {
    match error {
        SpoolError::ChainBroken(seq) => Error::ChainBroken(seq),
        SpoolError::Unreadable => Error::Unreadable,
        SpoolError::WriteFailed => Error::WriteFailed,
    }
}

fn decode(record: &crate::Record) -> Result<Record, Error> {
    let seq = record.document["seq"].as_u64().unwrap_or_default();
    if !record.document["at"]
        .as_str()
        .is_some_and(|at| at.ends_with('Z'))
    {
        return Err(Error::ChainBroken(seq));
    }
    let context: Context =
        serde_json::from_value(record.document.clone()).map_err(|_| Error::ChainBroken(seq))?;
    let obligation_id = record.document["obligation_id"]
        .as_str()
        .ok_or(Error::ChainBroken(seq))?
        .to_owned();
    let event = serde_json::from_value(json!({
        "event": record.document["event"], "fields": record.document["fields"]
    }))
    .map_err(|_| Error::ChainBroken(seq))?;
    Ok(Record {
        seq,
        hash: record.hash.clone(),
        support_ref: context.support_ref,
        entry: Entry {
            at: context.at,
            operator: context.operator,
            obligation_id,
            event,
        },
    })
}

impl RecordSpool for crate::RecordSpool {
    fn read(&self) -> Result<Vec<Record>, Error> {
        crate::RecordSpool::read(self)
            .map_err(storage)?
            .iter()
            .map(decode)
            .collect()
    }

    fn append(
        &self,
        support_ref: &str,
        build: impl FnOnce(&[Record]) -> Result<Entry, Error>,
    ) -> Result<Record, Error> {
        let record = crate::RecordSpool::append(self, support_ref, |records| {
            let records = records.iter().map(decode).collect::<Result<Vec<_>, _>>()?;
            let entry = build(&records)?;
            let document = serde_json::to_value(entry).map_err(|_| Error::WriteFailed)?;
            document.as_object().cloned().ok_or(Error::WriteFailed)
        })
        .map_err(|error| match error {
            AppendError::Storage(error) => storage(error),
            AppendError::Rejected(error) => error,
        })?;
        decode(&record)
    }
}
