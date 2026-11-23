//! Composition seams: adapters the app hands to domain routers.

#[cfg(feature = "ontology")]
pub(crate) mod dispatch;
#[cfg(feature = "attendance")]
pub(crate) mod leave_calendar;
#[cfg(feature = "mail")]
pub(crate) mod mail;
pub(crate) mod orgchange_people;
pub(crate) mod orgchange_ports;
pub(crate) mod orgchange_sole_holder;
pub(crate) mod realtime;
pub(crate) mod tenant_config;
