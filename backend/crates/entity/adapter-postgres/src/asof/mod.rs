//! Dated reads on the existing tenant-armed transaction.
//! Without an explicit recording cutoff, use all rows visible to that transaction. Their recording
//! timestamps can be ahead of the database clock after a backward adjustment. Business dates still apply.
pub(crate) mod dates;
pub(crate) mod membership;
pub(crate) mod placements;
pub(crate) mod projection;
mod records;
mod refusal;
pub(crate) mod registrations;
mod timeline;
mod timeline_changes;
mod timeline_scope;
pub(crate) mod tree;
