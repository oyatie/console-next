use async_imap::Session;
use async_imap::types::{Fetch, Flag, Name};
use console_comms_application::{
    FetchedMessage, ImapFolder, ImapSelect, ImapSession, MailFuture, MailServiceError,
    SYNC_FETCH_ITEMS,
};
use console_comms_domain::FolderRole;
use futures::StreamExt;
use time::OffsetDateTime;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::parse::{self, MessageFlags};

/// An authenticated IMAP session driving one account's mailbox.
pub(super) struct AsyncImapSession<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug> {
    // `Option` so `logout` can take ownership of the session (async-imap's logout
    // consumes `&mut self` but the Drop ordering is simplest with a take()).
    pub(super) session: Option<Session<T>>,
}

impl<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug> AsyncImapSession<T> {
    fn session_mut(&mut self) -> Result<&mut Session<T>, MailServiceError> {
        self.session.as_mut().ok_or(MailServiceError::Transport {
            code: "session_closed",
        })
    }
}

impl<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug + Send> ImapSession
    for AsyncImapSession<T>
{
    fn list_folders(&mut self) -> MailFuture<'_, Result<Vec<ImapFolder>, MailServiceError>> {
        Box::pin(async move {
            let session = self.session_mut()?;
            let mut stream = session.list(Some(""), Some("*")).await.map_err(|_| {
                MailServiceError::Transport {
                    code: "list_failed",
                }
            })?;
            let mut folders = Vec::new();
            while let Some(item) = stream.next().await {
                let name = item.map_err(|_| MailServiceError::Transport {
                    code: "list_failed",
                })?;
                if let Some(folder) = folder_from_name(&name) {
                    folders.push(folder);
                }
            }
            Ok(folders)
        })
    }

    fn select<'a>(
        &'a mut self,
        imap_path: &'a str,
    ) -> MailFuture<'a, Result<ImapSelect, MailServiceError>> {
        Box::pin(async move {
            let session = self.session_mut()?;
            let mailbox =
                session
                    .select(imap_path)
                    .await
                    .map_err(|_| MailServiceError::Transport {
                        code: "select_failed",
                    })?;
            Ok(ImapSelect {
                // A mailbox with no UIDVALIDITY is non-conformant; treat it as 0 so
                // the engine resets the cursor (refetch from the floor).
                uid_validity: mailbox.uid_validity.unwrap_or(0),
                uid_next: mailbox.uid_next,
                exists: mailbox.exists,
            })
        })
    }

    fn uids_since(
        &mut self,
        since_uid: u32,
        limit: u32,
    ) -> MailFuture<'_, Result<Vec<u32>, MailServiceError>> {
        Box::pin(async move {
            if limit == 0 || since_uid == u32::MAX {
                return Ok(Vec::new());
            }
            let range = format!("{}:*", since_uid + 1);
            let mut stream = self
                .session_mut()?
                .uid_fetch(range, "(UID)")
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "fetch_failed",
                })?;
            // A server may return unordered results, or the highest existing UID
            // when the requested range starts beyond it.
            let mut uids = std::collections::BTreeSet::new();
            while let Some(item) = stream.next().await {
                let fetch = item.map_err(|_| MailServiceError::Transport {
                    code: "fetch_failed",
                })?;
                if let Some(uid) = fetch.uid.filter(|uid| *uid > since_uid) {
                    uids.insert(uid);
                    if uids.len() > limit as usize {
                        uids.pop_last();
                    }
                }
            }
            Ok(uids.into_iter().collect())
        })
    }

    fn fetch_message(
        &mut self,
        uid: u32,
    ) -> MailFuture<'_, Result<Option<FetchedMessage>, MailServiceError>> {
        Box::pin(async move {
            let mut stream = self
                .session_mut()?
                .uid_fetch(uid.to_string(), SYNC_FETCH_ITEMS)
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "fetch_failed",
                })?;
            let mut message = None;
            while let Some(item) = stream.next().await {
                let fetch = item.map_err(|_| MailServiceError::Transport {
                    code: "fetch_failed",
                })?;
                if fetch.uid == Some(uid) && fetch.body().is_some() {
                    message = fetched_to_message(uid, &fetch);
                }
            }
            Ok(message)
        })
    }

    fn logout(&mut self) -> MailFuture<'_, ()> {
        Box::pin(async move {
            if let Some(mut session) = self.session.take() {
                let _ = session.logout().await;
            }
        })
    }
}

/// Classify a `LIST` entry into a [`ImapFolder`], or `None` for a `\Noselect`
/// container that holds no messages.
fn folder_from_name(name: &Name) -> Option<ImapFolder> {
    use async_imap::types::NameAttribute;
    if name
        .attributes()
        .iter()
        .any(|a| matches!(a, NameAttribute::NoSelect))
    {
        return None;
    }
    let path = name.name().to_owned();
    let role = classify_role(&path, name.delimiter());
    let display = display_name(&path, name.delimiter());
    Some(ImapFolder {
        imap_path: path,
        role,
        name: display,
    })
}

/// Map a mailbox path to a [`FolderRole`] by its (case-insensitive) leaf name.
fn classify_role(path: &str, delimiter: Option<&str>) -> FolderRole {
    let leaf = leaf_segment(path, delimiter).to_ascii_uppercase();
    match leaf.as_str() {
        "INBOX" => FolderRole::Inbox,
        "SENT" | "SENT ITEMS" | "SENT MAIL" | "SENT MESSAGES" => FolderRole::Sent,
        "DRAFTS" | "DRAFT" => FolderRole::Drafts,
        "ARCHIVE" | "ALL MAIL" => FolderRole::Archive,
        "TRASH" | "DELETED" | "DELETED ITEMS" | "BIN" => FolderRole::Trash,
        "JUNK" | "SPAM" | "JUNK E-MAIL" => FolderRole::Junk,
        _ => FolderRole::Custom,
    }
}

/// The human display name is the last path segment.
fn display_name(path: &str, delimiter: Option<&str>) -> String {
    let leaf = leaf_segment(path, delimiter);
    if leaf.trim().is_empty() {
        path.to_owned()
    } else {
        leaf.to_owned()
    }
}

/// The final hierarchy segment of a mailbox path (`[Gmail]/Sent Mail` → `Sent
/// Mail`), split on the server's hierarchy delimiter (default `/`).
fn leaf_segment<'a>(path: &'a str, delimiter: Option<&str>) -> &'a str {
    let delim = delimiter.filter(|d| !d.is_empty()).unwrap_or("/");
    path.rsplit(delim).next().unwrap_or(path)
}

/// Convert one `Fetch` (UID + FLAGS + INTERNALDATE + BODY.PEEK[]) into the
/// application's parsed message.
fn fetched_to_message(uid: u32, fetch: &Fetch) -> Option<FetchedMessage> {
    let body = fetch.body()?;
    let flags = flags_of(fetch);
    // async-imap's INTERNALDATE is a `chrono::DateTime<FixedOffset>`; convert via
    // its unix-second timestamp so this crate never names `chrono` directly.
    let internal = fetch
        .internal_date()
        .and_then(|dt| OffsetDateTime::from_unix_timestamp(dt.timestamp()).ok());
    parse::parse_message(uid, flags, internal, body)
}

/// Map the IMAP `FLAGS` set to the boolean flags the engine persists.
fn flags_of(fetch: &Fetch) -> MessageFlags {
    let mut flags = MessageFlags::default();
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => flags.seen = true,
            Flag::Flagged => flags.flagged = true,
            Flag::Answered => flags.answered = true,
            Flag::Draft => flags.draft = true,
            _ => {}
        }
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_role_maps_well_known_folders() {
        assert_eq!(classify_role("INBOX", None), FolderRole::Inbox);
        assert_eq!(
            classify_role("[Gmail]/Sent Mail", Some("/")),
            FolderRole::Sent
        );
        assert_eq!(classify_role("Drafts", None), FolderRole::Drafts);
        assert_eq!(classify_role("Junk", None), FolderRole::Junk);
        assert_eq!(classify_role("Trash", None), FolderRole::Trash);
        assert_eq!(
            classify_role("Projects/2026", Some("/")),
            FolderRole::Custom
        );
    }

    #[test]
    fn leaf_segment_handles_nested_paths() {
        assert_eq!(leaf_segment("[Gmail]/Sent Mail", Some("/")), "Sent Mail");
        assert_eq!(leaf_segment("INBOX", Some("/")), "INBOX");
        assert_eq!(leaf_segment("a.b.c", Some(".")), "c");
    }

    #[tokio::test]
    async fn attachment_folder_fetches_ordered_individual_bodies() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        // 22 individually valid 24 MiB parts exceed a 512 MiB worker in aggregate.
        // Stream the fixture so the mock mailbox does not hold the batch either.
        const MESSAGES: u32 = 22;
        const PART_BYTES: usize = 24 * 1024 * 1024;
        let (client, server) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut commands = BufReader::new(read).lines();
            let login = commands.next_line().await.unwrap().unwrap();
            let tag = login.split_whitespace().next().unwrap();
            write
                .write_all(format!("{tag} OK logged in\r\n").as_bytes())
                .await
                .unwrap();
            let lookup = commands.next_line().await.unwrap().unwrap();
            assert!(lookup.ends_with("UID FETCH 1:* (UID)"));
            for uid in (1..=MESSAGES + 1).rev() {
                write
                    .write_all(format!("* {uid} FETCH (UID {uid})\r\n").as_bytes())
                    .await
                    .unwrap();
            }
            let tag = lookup.split_whitespace().next().unwrap();
            write
                .write_all(format!("{tag} OK UIDs\r\n").as_bytes())
                .await
                .unwrap();

            let head = b"From: a@example.org\r\nSubject: Photo\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=parts\r\n\r\n--parts\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=photo.bin\r\n\r\n";
            let tail = b"\r\n--parts--\r\n";
            let chunk = [b'x'; 16 * 1024];
            for uid in 1..=MESSAGES {
                let fetch = commands.next_line().await.unwrap().unwrap();
                assert!(fetch.ends_with(&format!("UID FETCH {uid} {SYNC_FETCH_ITEMS}")));
                let tag = fetch.split_whitespace().next().unwrap();
                let size = head.len() + PART_BYTES + tail.len();
                write
                    .write_all(
                        format!("* {uid} FETCH (UID {uid} FLAGS () BODY[] {{{size}}}\r\n")
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
                write.write_all(head).await.unwrap();
                for _ in 0..(PART_BYTES / chunk.len()) {
                    write.write_all(&chunk).await.unwrap();
                }
                write.write_all(tail).await.unwrap();
                write
                    .write_all(format!(")\r\n{tag} OK body\r\n").as_bytes())
                    .await
                    .unwrap();
            }
        });

        let session = async_imap::Client::new(client)
            .login("tester", "fixture")
            .await
            .unwrap();
        let mut imap = AsyncImapSession {
            session: Some(session),
        };
        let uids = imap.uids_since(0, MESSAGES).await.unwrap();
        assert_eq!(uids, (1..=MESSAGES).collect::<Vec<_>>());
        for uid in uids {
            let message = imap.fetch_message(uid).await.unwrap().unwrap();
            assert_eq!(message.imap_uid, uid);
            assert_eq!(message.attachments.len(), 1);
            assert_eq!(message.attachments[0].bytes.len(), PART_BYTES);
        }
        server.await.unwrap();
    }
}
