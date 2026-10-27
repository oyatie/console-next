<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

# Obligation record spool

`RecordSpool` stores create-only `<seq:08>.json` records under the configured
records directory's `obligations/` prefix. Opening, reading and appending verify
the sequence and SHA-256 `prev` chain. `Record.document` is the stored JSON;
`Record.hash` hashes its exact disk bytes. Event, date and operator validation
belong to the application.

Create and share one instance per writer process. The `append` callback receives
verified history under the writer lock; validate transitions there and return
the event fields. Storage owns `v`, `seq`, `prev` and the request's `support_ref`.
A rejected callback writes nothing.

Appends write and fsync `.obligations-pending` beside `obligations/`, then
hard-link the complete file into its numbered destination without overwriting
an existing record, and fsync the obligations directory. The temporary link is
removed afterwards. An interrupted staging write is outside the verified chain;
the next append discards that temporary file and retries the same sequence.
Temporary cleanup failure is logged and does not undo a durable commit.
Multiple writer processes or independent spool instances are unsupported.

- `ChainBroken(seq)` identifies an invalid record or broken chain.
- `Unreadable` means the spool cannot be verified, including a symlinked prefix.
  Treat this as an unknown source, never an empty register.
- `WriteFailed` means the append could not be durably committed. A failed
  directory sync attempts rollback; an uncertain removal or rollback sync makes
  the instance refuse all later reads and appends, requiring repair and reopening.

After a successful commit, the exact compact JSON is emitted in tracing's
`record` field for one-line log export. Refusals export no committed record.
Write and verification outcomes also increment the `ops_cockpit_record_*_total`
metrics.

The chain alone cannot authenticate an edited or truncated final suffix after a
restart. Exported record hashes in the locked log must externally anchor the
tail to detect that case.
