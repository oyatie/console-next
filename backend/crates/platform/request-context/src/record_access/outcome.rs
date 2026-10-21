//! Composition can reuse a domain's current read projection without a platform-to-domain dependency.
use console_platform_authz::Principal;
use console_platform_db::command_outcomes::CommandOutcome;
use sqlx::PgPool;
use std::{future::Future, pin::Pin};

pub type ReadFuture<'a> = Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

#[derive(Clone, Copy)]
pub struct Reader(
    pub for<'a> fn(&'a PgPool, &'a Principal, &'a mut CommandOutcome) -> ReadFuture<'a>,
);

pub async fn readable(
    pool: &PgPool,
    p: &Principal,
    out: &mut CommandOutcome,
    reader: Option<Reader>,
) -> bool {
    match reader {
        Some(Reader(read)) => read(pool, p, out).await,
        None => super::all_readable(pool, p, &out.touched).await,
    }
}
