// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::Path;

use console_ops_application::obligations::{Context, Error as SpoolError};
use console_ops_application::promote::{
    FeedbackStore, FeedbackTriage, PromotionSignoff, PromotionStore,
};
use serde_json::Value;

use crate::stores::{common_fields, map_append_err, map_spool_err, record_meta};
use crate::{RecordSpool, SpoolPrefix};

pub struct FsPromotionStore {
    spool: RecordSpool,
}

impl FsPromotionStore {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            spool: RecordSpool::open_resilient_prefix(records_dir, SpoolPrefix::Promotions),
        }
    }

    pub fn spool(&self) -> &RecordSpool {
        &self.spool
    }
}

impl PromotionStore for FsPromotionStore {
    fn list_signoffs(&self) -> Result<Vec<PromotionSignoff>, SpoolError> {
        let records = self.spool.read().map_err(map_spool_err)?;
        records
            .iter()
            .map(|r| {
                let (seq, at, support_ref, operator) = record_meta(r)?;
                Ok(PromotionSignoff {
                    seq,
                    hash: r.hash.clone(),
                    support_ref,
                    at,
                    operator,
                    digest: r.document["digest"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    verdict: r.document["verdict"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    note: r.document["note"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                })
            })
            .collect()
    }

    fn record_signoff(
        &self,
        digest: &str,
        verdict: &str,
        note: &str,
        context: &Context,
    ) -> Result<PromotionSignoff, SpoolError> {
        let rec = self
            .spool
            .append(&context.support_ref, |_| {
                let mut doc = common_fields(context);
                doc.insert(
                    "event".to_owned(),
                    Value::String("promotion_signoff".to_owned()),
                );
                doc.insert("digest".to_owned(), Value::String(digest.to_owned()));
                doc.insert("verdict".to_owned(), Value::String(verdict.to_owned()));
                doc.insert("note".to_owned(), Value::String(note.to_owned()));
                Ok::<_, SpoolError>(doc)
            })
            .map_err(map_append_err)?;
        let (seq, at, support_ref, operator) = record_meta(&rec)?;
        Ok(PromotionSignoff {
            seq,
            hash: rec.hash,
            support_ref,
            at,
            operator,
            digest: digest.to_owned(),
            verdict: verdict.to_owned(),
            note: note.to_owned(),
        })
    }
}

pub struct FsFeedbackStore {
    spool: RecordSpool,
}

impl FsFeedbackStore {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            spool: RecordSpool::open_resilient_prefix(records_dir, SpoolPrefix::Feedback),
        }
    }

    pub fn spool(&self) -> &RecordSpool {
        &self.spool
    }
}

impl FeedbackStore for FsFeedbackStore {
    fn list_feedback(&self) -> Result<Vec<FeedbackTriage>, SpoolError> {
        let records = self.spool.read().map_err(map_spool_err)?;
        records
            .iter()
            .map(|r| {
                let (seq, at, support_ref, operator) = record_meta(r)?;
                Ok(FeedbackTriage {
                    seq,
                    hash: r.hash.clone(),
                    support_ref,
                    at,
                    operator,
                    feedback_id: r.document["feedback_id"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    digest: r.document["digest"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    severity: r.document["severity"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    disposition: r.document["disposition"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                    note: r.document["note"]
                        .as_str()
                        .ok_or(SpoolError::ChainBroken(seq))?
                        .to_owned(),
                })
            })
            .collect()
    }

    fn record_triage(
        &self,
        feedback_id: &str,
        digest: &str,
        severity: &str,
        disposition: &str,
        note: &str,
        context: &Context,
    ) -> Result<FeedbackTriage, SpoolError> {
        let rec = self
            .spool
            .append(&context.support_ref, |_| {
                let mut doc = common_fields(context);
                doc.insert(
                    "event".to_owned(),
                    Value::String("feedback_triage".to_owned()),
                );
                doc.insert(
                    "feedback_id".to_owned(),
                    Value::String(feedback_id.to_owned()),
                );
                doc.insert("digest".to_owned(), Value::String(digest.to_owned()));
                doc.insert("severity".to_owned(), Value::String(severity.to_owned()));
                doc.insert(
                    "disposition".to_owned(),
                    Value::String(disposition.to_owned()),
                );
                doc.insert("note".to_owned(), Value::String(note.to_owned()));
                Ok::<_, SpoolError>(doc)
            })
            .map_err(map_append_err)?;
        let (seq, at, support_ref, operator) = record_meta(&rec)?;
        Ok(FeedbackTriage {
            seq,
            hash: rec.hash,
            support_ref,
            at,
            operator,
            feedback_id: feedback_id.to_owned(),
            digest: digest.to_owned(),
            severity: severity.to_owned(),
            disposition: disposition.to_owned(),
            note: note.to_owned(),
        })
    }
}
