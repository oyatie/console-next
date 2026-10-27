// SPDX-License-Identifier: LicenseRef-Proprietary
//! File mechanics for the obligations prefix; the application validates event fields.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub document: Value,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpoolError {
    ChainBroken(u64),
    Unreadable,
    WriteFailed,
}

#[derive(Debug)]
pub enum AppendError<E> {
    Storage(SpoolError),
    Rejected(E),
}

pub struct RecordSpool {
    directory: PathBuf,
    // An uncertain rollback refuses subsequent reads until the operator repairs the spool.
    uncertain: Mutex<bool>,
}

impl RecordSpool {
    pub fn open(records_dir: &Path) -> Result<Self, SpoolError> {
        let directory = records_dir.join("obligations");
        match fs::create_dir(&directory) {
            Ok(()) => File::open(records_dir)
                .and_then(|parent| parent.sync_all())
                .map_err(|_| SpoolError::Unreadable)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(SpoolError::Unreadable),
        }
        let spool = Self {
            directory,
            uncertain: Mutex::new(false),
        };
        for outcome in ["ok", "error"] {
            metrics::counter!("ops_cockpit_record_writes_total", "outcome" => outcome).increment(0);
            metrics::counter!("ops_cockpit_record_verifications_total", "outcome" => outcome)
                .increment(0);
        }
        spool.read()?;
        Ok(spool)
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn read(&self) -> Result<Vec<Record>, SpoolError> {
        let uncertain = self.uncertain.lock().map_err(|_| SpoolError::Unreadable)?;
        if *uncertain {
            return Err(SpoolError::Unreadable);
        }
        self.verify()
    }

    /// Validation and persistence share the lock, so concurrent final events cannot both commit.
    /// `build` supplies application-validated fields; storage owns v, seq and prev.
    pub fn append<E>(
        &self,
        support_ref: &str,
        build: impl FnOnce(&[Record]) -> Result<Map<String, Value>, E>,
    ) -> Result<Record, AppendError<E>> {
        let _span = tracing::info_span!("ops_record_write", support_ref).entered();
        let result = self.append_locked(support_ref, build);
        let outcome = match &result {
            Ok(_) => "ok",
            Err(AppendError::Storage(error)) => {
                tracing::warn!(?error, "ops record append refused");
                "error"
            }
            Err(AppendError::Rejected(_)) => return result,
        };
        metrics::counter!("ops_cockpit_record_writes_total", "outcome" => outcome).increment(1);
        result
    }

    fn append_locked<E>(
        &self,
        support_ref: &str,
        build: impl FnOnce(&[Record]) -> Result<Map<String, Value>, E>,
    ) -> Result<Record, AppendError<E>> {
        let mut uncertain = self
            .uncertain
            .lock()
            .map_err(|_| AppendError::Storage(SpoolError::WriteFailed))?;
        if *uncertain {
            return Err(AppendError::Storage(SpoolError::Unreadable));
        }
        let records = self.verify().map_err(AppendError::Storage)?;
        let mut document = build(&records).map_err(AppendError::Rejected)?;
        let seq = records.len() as u64 + 1;
        let prev = records.last().map_or("genesis", |record| &record.hash);
        document.insert("v".into(), 1.into());
        document.insert("seq".into(), seq.into());
        document.insert("prev".into(), prev.into());
        document.insert("support_ref".into(), support_ref.into());
        let document = Value::Object(document);
        let bytes = serde_json::to_vec(&document)
            .map_err(|_| AppendError::Storage(SpoolError::WriteFailed))?;
        self.persist(seq, &bytes, &mut uncertain)
            .map_err(AppendError::Storage)?;
        tracing::info!(
            record = %String::from_utf8_lossy(&bytes),
            support_ref = document["support_ref"].as_str(),
            "ops record committed"
        );
        Ok(Record {
            document,
            hash: hex::encode(Sha256::digest(&bytes)),
        })
    }

    fn persist(&self, seq: u64, bytes: &[u8], uncertain: &mut bool) -> Result<(), SpoolError> {
        let directory = File::open(&self.directory).map_err(|_| SpoolError::WriteFailed)?;
        let path = self.directory.join(format!("{seq:08}.json"));
        let pending = self.directory.with_file_name(".obligations-pending");
        match fs::remove_file(&pending) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SpoolError::WriteFailed),
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|_| SpoolError::WriteFailed)?;
        #[cfg(test)]
        tests::interrupt_write(&mut file);
        let mut published = false;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::hard_link(&pending, &path)?;
            published = true;
            #[cfg(test)]
            tests::fail(tests::Failure::CommitSync)?;
            directory.sync_all()
        })();
        drop(file);
        if let Err(error) = &result {
            if published {
                *uncertain = (|| {
                    #[cfg(test)]
                    tests::fail(tests::Failure::RollbackRemove)?;
                    fs::remove_file(&path)?;
                    #[cfg(test)]
                    tests::fail(tests::Failure::RollbackSync)?;
                    directory.sync_all()
                })()
                .is_err();
            }
            tracing::error!(%error, rollback_uncertain = *uncertain, "ops record write failed");
        }
        if let Err(error) = fs::remove_file(&pending) {
            tracing::warn!(%error, "ops record temporary file cleanup failed");
        }
        result.map_err(|_| SpoolError::WriteFailed)
    }

    fn verify(&self) -> Result<Vec<Record>, SpoolError> {
        let _span = tracing::info_span!("ops_record_verify").entered();
        let result = self.verify_records();
        metrics::counter!(
            "ops_cockpit_record_verifications_total",
            "outcome" => if result.is_ok() { "ok" } else { "error" }
        )
        .increment(1);
        result
    }

    fn verify_records(&self) -> Result<Vec<Record>, SpoolError> {
        // shortcut: an unanchored tail cannot detect truncation; upgrade when exported record hashes anchor the tail.
        let metadata = fs::symlink_metadata(&self.directory).map_err(|_| SpoolError::Unreadable)?;
        if !metadata.is_dir() {
            return Err(SpoolError::Unreadable);
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.directory).map_err(|_| SpoolError::Unreadable)? {
            let entry = entry.map_err(|_| SpoolError::Unreadable)?;
            let name = entry.file_name();
            let seq = name
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
                .and_then(|name| name.parse::<u64>().ok())
                .filter(|seq| *seq > 0)
                .ok_or(SpoolError::Unreadable)?;
            if name != format!("{seq:08}.json").as_str() {
                return Err(SpoolError::ChainBroken(seq));
            }
            if !entry
                .file_type()
                .map_err(|_| SpoolError::Unreadable)?
                .is_file()
            {
                return Err(SpoolError::ChainBroken(seq));
            }
            entries.push((seq, entry.path()));
        }
        entries.sort_by_key(|(seq, _)| *seq);
        let mut records: Vec<Record> = Vec::new();
        for (seq, path) in entries {
            let expected = records.len() as u64 + 1;
            if seq != expected {
                return Err(SpoolError::ChainBroken(expected));
            }
            let bytes = fs::read(path).map_err(|_| SpoolError::Unreadable)?;
            let document: Value =
                serde_json::from_slice(&bytes).map_err(|_| SpoolError::ChainBroken(seq))?;
            if document["v"] != 1 || document["seq"].as_u64() != Some(seq) {
                return Err(SpoolError::ChainBroken(seq));
            }
            let prev = records.last().map_or("genesis", |record| &record.hash);
            if document["prev"].as_str() != Some(prev) {
                return Err(SpoolError::ChainBroken(seq.saturating_sub(1).max(1)));
            }
            records.push(Record {
                document,
                hash: hex::encode(Sha256::digest(&bytes)),
            });
        }
        Ok(records)
    }
}
