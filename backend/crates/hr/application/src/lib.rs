//! HR application layer (ring 2).
//!
//! Created by PREREG-3 at hr-application's first BW use (OD-1): the lifecycle
//! apply hooks LIFE calls and EXIT implements (concurrency-plan C8). LIFE owns
//! `lifecycle/**` apart from `hooks.rs`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod lifecycle;

pub mod statutory;
