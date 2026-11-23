// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::Path;
use std::sync::Arc;

use crate::{
    FsActionStore, FsAlertAckStore, FsFeedbackStore, FsIncidentStore, FsPromotionStore,
    FsSilenceSpool, RecordSpool, SpoolError, SpoolPrefix,
};

pub struct SpoolSet {
    pub obligations: Arc<RecordSpool>,
    pub alerts: Arc<FsAlertAckStore>,
    pub silences: Arc<FsSilenceSpool>,
    pub incidents: Arc<FsIncidentStore>,
    pub actions: Arc<FsActionStore>,
    pub promotions: Arc<FsPromotionStore>,
    pub feedback: Arc<FsFeedbackStore>,
    pub reviews: Arc<RecordSpool>,
    pub breakglass: Arc<RecordSpool>,
}

impl SpoolSet {
    pub fn open_resilient(records_dir: &Path) -> Self {
        Self {
            obligations: Arc::new(RecordSpool::open_resilient_prefix(
                records_dir,
                SpoolPrefix::Obligations,
            )),
            alerts: Arc::new(FsAlertAckStore::open_resilient(records_dir)),
            silences: Arc::new(FsSilenceSpool::open_resilient(records_dir)),
            incidents: Arc::new(FsIncidentStore::open_resilient(records_dir)),
            actions: Arc::new(FsActionStore::open_resilient(records_dir)),
            promotions: Arc::new(FsPromotionStore::open_resilient(records_dir)),
            feedback: Arc::new(FsFeedbackStore::open_resilient(records_dir)),
            reviews: Arc::new(RecordSpool::open_resilient_prefix(
                records_dir,
                SpoolPrefix::Reviews,
            )),
            breakglass: Arc::new(RecordSpool::open_resilient_prefix(
                records_dir,
                SpoolPrefix::Breakglass,
            )),
        }
    }

    pub fn verify_all(&self) -> Vec<(SpoolPrefix, Result<usize, SpoolError>)> {
        let spools: [&RecordSpool; 9] = [
            &self.obligations,
            self.alerts.spool(),
            self.silences.spool(),
            self.incidents.spool(),
            self.actions.spool(),
            self.promotions.spool(),
            self.feedback.spool(),
            &self.reviews,
            &self.breakglass,
        ];
        spools
            .into_iter()
            .map(|spool| (spool.prefix(), spool.read().map(|records| records.len())))
            .collect()
    }
}
