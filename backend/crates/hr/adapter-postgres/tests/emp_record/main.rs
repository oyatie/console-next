#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    unused_imports
)]
//! EMP-RECORD (MR-31, MR-33, MR-35) through the `HrService` entry points the routes call,
//! on a `console_rt` pool, so the 0261/0262 grants, CHECKs and RLS are what is
//! proved.

mod access;
mod company;
mod entries;
mod fixture;
mod former;
mod import;
mod restricted;
mod restricted_holder;
