#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    unused_imports
)]
//! EMP-MODEL through the `HrService` entry points the routes call, on a
//! `console_rt` pool (so the 0256 column grants and RLS are what is proved).

mod authz;
mod contracts;
mod facts;
mod fixture;

mod warnings;
