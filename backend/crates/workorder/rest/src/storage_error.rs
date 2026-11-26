// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{RestError, StorageError};

impl RestError {
    pub(super) fn from_storage(error: StorageError) -> Self {
        match error {
            StorageError::Domain(error) => Self::from_kernel(error),
            StorageError::Db(error) => Self::from_db(error),
            err @ (StorageError::Response { .. } | StorageError::Retained) => {
                Self::internal(err.to_string())
            }
            StorageError::S3(message)
            | StorageError::Presign(message)
            | StorageError::Verification(message)
            | StorageError::Processing(message) => Self::internal(message),
        }
    }
}
