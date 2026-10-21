//! Webmail attachment store wiring.

use crate::mail_sync;
use crate::state::AppState;
use std::sync::Arc;

/// Build the inbound-attachment object store the webmail read API uses for
/// presigned GETs, from the same storage config the evidence pipeline uses.
/// `None` when storage is unconfigured (the attachment-download endpoint 503s).
pub(crate) fn mail_attachment_store(
    state: &AppState,
) -> Option<console_comms_rest::SharedAttachmentStore> {
    state.sales_media_storage.as_ref().map(|(store, bucket)| {
        Arc::new(mail_sync::S3MailAttachmentStore::new(
            store.clone(),
            bucket.clone(),
        )) as console_comms_rest::SharedAttachmentStore
    })
}

// --- ontology §18 projected-dispatch registry (App-tier only; the ontology
// REST tier stays free of a domain-adapter edge, exactly like
// `TenantConfigSeeder` — see `console_ontology_rest::ProjectedDispatchRegistry`
// module docs) ---------------------------------------------------------------
