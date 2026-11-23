// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::Path;

use console_ops_application::actions::{
    ActionRecord, ActionStatus, ActionStore, CmdHandOffInput, new_action_id,
};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::changes::CmdHandOff;
use console_ops_application::obligations::{Context, Error as SpoolError};
use serde_json::Value;

use crate::stores::{common_fields, map_append_err, map_spool_err, record_meta};
use crate::{RecordSpool, SpoolPrefix};

pub struct FsActionStore {
    spool: RecordSpool,
}

impl FsActionStore {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            spool: RecordSpool::open_resilient_prefix(records_dir, SpoolPrefix::Actions),
        }
    }

    pub fn spool(&self) -> &RecordSpool {
        &self.spool
    }
}

impl ActionStore for FsActionStore {
    fn list_actions(&self) -> Result<Vec<ActionRecord>, SpoolError> {
        let records = self.spool.read().map_err(map_spool_err)?;
        records
            .iter()
            .map(|r| {
                let (seq, at, support_ref, operator) = record_meta(r)?;
                let handoff: CmdHandOff = serde_json::from_value(r.document["handoff"].clone())
                    .map_err(|_| SpoolError::ChainBroken(seq))?;
                let status: ActionStatus = serde_json::from_value(r.document["status"].clone())
                    .map_err(|_| SpoolError::ChainBroken(seq))?;
                Ok(ActionRecord {
                    seq,
                    hash: r.hash.clone(),
                    support_ref,
                    at,
                    operator,
                    status,
                    handoff,
                })
            })
            .collect()
    }

    fn record_handoff(
        &self,
        input: &CmdHandOffInput<'_>,
        context: &Context,
    ) -> Result<ActionRecord, SpoolError> {
        let rec = self
            .spool
            .append(&context.support_ref, |records| {
                let seq = records.len() as u64 + 1;
                let handoff = CmdHandOff {
                    action_id: new_action_id(seq),
                    kind: input.kind.to_owned(),
                    command: input.command.to_owned(),
                    target: input.target.to_owned(),
                    consequence: input.consequence.to_owned(),
                    expected_result: input.expected_result.to_owned(),
                    verify_step: input.verify_step.to_owned(),
                    operator: context.operator.person.clone(),
                    at: UtcTimestamp::new(context.at),
                };
                let mut doc = common_fields(context);
                doc.insert("event".to_owned(), Value::String("cmd_handoff".to_owned()));
                doc.insert(
                    "status".to_owned(),
                    serde_json::to_value(ActionStatus::Pending)
                        .map_err(|_| SpoolError::WriteFailed)?,
                );
                doc.insert(
                    "handoff".to_owned(),
                    serde_json::to_value(&handoff).map_err(|_| SpoolError::WriteFailed)?,
                );
                Ok(doc)
            })
            .map_err(map_append_err)?;
        let (seq, at, support_ref, operator) = record_meta(&rec)?;
        let handoff: CmdHandOff = serde_json::from_value(rec.document["handoff"].clone())
            .map_err(|_| SpoolError::ChainBroken(seq))?;
        Ok(ActionRecord {
            seq,
            hash: rec.hash,
            support_ref,
            at,
            operator,
            status: ActionStatus::Pending,
            handoff,
        })
    }
}
