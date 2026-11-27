// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_storage::{
    CopyObjectRequest, ObjectHead, PresignGetRequest, PresignPutRequest, PresignedUpload,
    RetentionInfo, S3ObjectStore, StorageError, StorageFuture,
};
use std::{collections::HashSet, sync::Mutex};

#[derive(Default)]
pub struct FakeS3Store {
    pub deletes: Mutex<Vec<(String, String)>>,
    pub worm_replica_locked: bool,
    pub permission_denied_key: Option<String>,
    pub not_found_keys: HashSet<String>,
}

impl S3ObjectStore for FakeS3Store {
    fn presign_put(&self, _: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
        unreachable!()
    }
    fn presign_get(&self, _: PresignGetRequest) -> StorageFuture<'_, String> {
        unreachable!()
    }
    fn copy_object(&self, _: CopyObjectRequest) -> StorageFuture<'_, ()> {
        unreachable!()
    }
    fn head_object(&self, _: String, _: String) -> StorageFuture<'_, ObjectHead> {
        unreachable!()
    }
    fn get_object_retention(&self, _: String, _: String) -> StorageFuture<'_, RetentionInfo> {
        unreachable!()
    }
    fn get_object(&self, _: String, _: String) -> StorageFuture<'_, Vec<u8>> {
        unreachable!()
    }
    fn put_object(&self, _: String, _: String, _: String, _: Vec<u8>) -> StorageFuture<'_, ()> {
        unreachable!()
    }
    fn delete_object(&self, _: String, _: String) -> StorageFuture<'_, ()> {
        unreachable!()
    }
    fn purge_object(&self, bucket: String, key: String) -> StorageFuture<'_, ()> {
        Box::pin(async move {
            if bucket == "replica-bkt"
                && self.permission_denied_key.as_deref() == Some(key.as_str())
            {
                return Err(StorageError::Response {
                    operation: "delete version".into(),
                    status: 403,
                    code: "AccessDenied".into(),
                });
            }
            if self.worm_replica_locked && bucket == "replica-bkt" {
                return Err(StorageError::Response {
                    operation: "delete version".into(),
                    status: 403,
                    code: "ObjectLocked".into(),
                });
            }
            if self.not_found_keys.contains(&key) {
                return Ok(());
            }
            self.deletes.lock().unwrap().push((bucket, key));
            Ok(())
        })
    }
}
