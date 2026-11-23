# Account and sync design

Status: the Django protocol and automatic mobile foreground synchronization/restoration are implemented and checked against the local development server with synthetic data. Native/device UI validation and production durability remain outstanding. Updated: 2026-11-15.

## Identity

Registration, login, and `GET /api/v1/account` return `accountId`, a UUID created once for that account. It is not the email and it is not reused. Deleting the account stores that UUID on `DeletedAccount`. A later registration with the same email receives a new UUID.

The phone names the signed-in SQLite file `liftlog-<accountId>.db`. The original `liftlog.db` stays the local-only workspace. Sign-in does not copy it.

An older install may still have `liftlog-<email-hash>.db`. If that person is already signed in when the app learns the account id, that file is copied once into the account-id file. The copy is one transaction and a second run does not duplicate rows. A new sign-in, including the same email after account deletion or against a different server database, does not attach that older file. Settings → Account asks once whether to keep it with this account or leave it separate. Explicit association now queues the copied records for upload after cloud consent; the original source remains separate and unchanged. Collisions require an explicit keep-both choice.

## Sessions and cloud consent

Sessions, logout, and login limits are unchanged. Cloud storage consent is `POST /api/v1/account/consent` with `{"cloudSync": "2026-11-05"}`. The explicit Create account action sends `cloudSyncConsent: "2026-11-05"`, recorded atomically at registration; existing accounts enable cloud storage explicitly. Login does not grant it. Chat consent and model consent are separate. Push refuses to write without the stored cloud-sync version.

Password reset is still specified and not built. No mail is sent.

## What the server stores

Owned by the authenticated account, never by a client-supplied owner id:

- Exercise: client id, type, name, bar weight. The same seed name on two phones stays two rows unless the client ids match for that account. The server does not collapse ids by name.
- Exercise alias: client id, parent exercise id, name, canonical flag.
- Workout: client id, date, label, started and ended timestamps. Nulls stay null.
- Workout exercise: client id, parent workout id, parent exercise id, position.
- Performed set: client id, parent workout-exercise id, position, load text, reps, duration, assisted, note, logged time.
- Training profile: one row, with unknown fields left null.

Every parent id in a write must already be a live row for the same account, including a parent created earlier in the same batch. Another account’s id is not a parent.

## Push

`POST /api/v1/sync/push`

```json
{
  "accountId": "<uuid>",
  "consent": { "cloudSync": "2026-11-05" },
  "operations": [
    {
      "opId": "<id>",
      "fingerprint": "<sha256>",
      "kind": "upsert",
      "recordType": "workout_set",
      "clientId": "<id>",
      "baseRevision": 1,
      "payload": {}
    }
  ]
}
```

A batch holds at most 50 operations. The fingerprint is SHA-256 of the canonical JSON for `kind`, `recordType`, `clientId`, `baseRevision`, and `payload`, with sorted keys. Delete operations use `payload: null`.

The account id must be the caller’s. A deleted account id returns `410` `ACCOUNT_GONE` and writes nothing. The batch commits in one database transaction: receipts, live rows, tombstones, suppressions, and change-log rows succeed or roll back together.

Replaying an accepted `opId` with the same fingerprint returns the original result and `replayed: true`. The same id with a different fingerprint returns `409` `OPERATION_MISMATCH` and does not change the row.

`baseRevision` is the server revision the device last stored for that record. `0` means the device believes the record is new. A mismatch returns `409` `CONFLICT` with the current server record and the rejected payload. The stored row stays as it was. Device clocks are not compared. A conflict rolls back the whole batch so an earlier operation in that request is not left applied.

`association` is optional and is not automatically sent by the phone. `{ "priorAccountId", "confirmed": true }` is required before client ids suppressed for a deleted account with the same email can be written onto a new account. Without it, those ids return `SUPPRESSED` and are not revived.

## Pull

`GET /api/v1/sync/pull?cursor=<n>&limit=<n>`

`cursor=0` reads the retained change log from the start. Later calls pass the `cursor` returned by the previous page. `complete: false` means another page remains. Repeating the same cursor returns the same page, so an interrupted download can resume. A cursor below the retained floor, or ahead of the account cursor, returns `409` `CURSOR_EXPIRED` with `recovery: "full"`. The client then pulls from `cursor=0`.

Deleted changes have `deleted: true` and `payload: null`. After a record is deleted, later pulls do not include its load, note, or profile text.

`compact_change_log` drops change-log rows at or below a floor and writes the current live rows and tombstones again. It is not on a schedule. There is no server backup snapshot job.

## Deletion

`POST /api/v1/account/delete` with `{"confirm": true, "password": "..."}` checks the password, revokes every session, removes live workout and profile payloads, writes payload-free tombstones and permanent suppressions, and records the account UUID as deleted. A wrong password deletes nothing and is not echoed.

A deleted record cannot be upserted back. A stale update returns the tombstone and the rejected payload. The same client id from a recreated account stays suppressed until an explicit association confirms the prior account id.

No running server backup snapshot/purge job or backup retention interval has been verified. There is no 30-day deletion guarantee. DeletedAccount/Suppression retain email and identity/client-ID deletion markers to prevent resurrection. Production must choose retention and prove tombstone/suppression replay after restoration before promising recovery or erasure timing.

## Mobile foreground synchronization

The account workspace captures local changes in a transactional outbox and automatically reconciles after login, on foreground, after debounced edits and on connectivity hints. Requests have deadlines, batches are bounded, and retries back off. Account generation/origin checks invalidate late responses. Logging does not wait for a request, and no behavior depends on execution while the app is suspended or closed.

Initial history/profile pages download automatically. Each page and cursor commit together. Cursor expiry restarts the download without clearing unsent edits; dirty versions and local constraint collisions are staged for explicit resolution. Fresh default catalog records are not mistaken for user changes. Home/History/Profile distinguish initial restoration from a confirmed empty account. Ordinary pending counts and success notifications remain offscreen.

Cloud consent and model consent are separate. Anonymous and legacy association requires explicit action and is retry-safe, preserves the source and handles colliding identities. Account-backed backup replacement is guarded pending a separate server-aware import design; anonymous restore and exports remain available.

Database and real local HTTP tests passed; browser SQLite startup and simulator launch were blocked in this environment. Physical-device flows have not passed. Production hosting, backups and recovery verification are not supplied by development-server sync.

## HTTP boundary

| Method and path | Auth | Behavior |
| --- | --- | --- |
| `POST /api/v1/auth/register` | open | Create the user and any explicitly supplied cloud consent atomically; return `accountId` and one session |
| `POST /api/v1/auth/login` | open | Return the same `accountId` and a new session |
| `POST /api/v1/auth/logout` | session | Revoke the presented session |
| `GET` or `PATCH /api/v1/account` | session | Read or update the caller’s display name |
| `POST /api/v1/account/consent` | session | Store cloud-sync consent version `2026-11-05` |
| `POST /api/v1/account/delete` | session | Delete the account after the password is confirmed |
| `POST /api/v1/sync/push` | session | Apply one batch for the caller |
| `GET /api/v1/sync/pull` | session | Page the caller’s change log |
| `POST /api/v1/chat/interpret` | session, or local-dev open | Interpreter. Stores no transcript |
| `POST /api/v1/analytics/trends` | session, or local-dev open | Unchanged calculation |

Chat and trends stay open without a session only when `DJANGO_DEBUG=1` and `LIFTLOG_LOCAL_DEV_OPEN=1`.


## November 15 security boundaries

Credentials and account workspaces are pinned to their normalized original server address. HTTPS is required outside the development loopback exception. Redirects are rejected. Legacy credentials without a destination require reauthentication. A different server returning the same account UUID cannot rebind an old account database. An address/history migration requires a separate verified design.

The Account screen now supports explicit password-confirmed deletion. It persists pending quarantine before network work, stops sync and invalidates in-flight generations. Only an identity-matching deletion receipt confirms success. Uncertain responses remain quarantined; retry logs into the original server and checks the original UUID before deletion. Same-email recreation cannot inherit/reopen the old account copy. Guest/other-account data stays separate. Confirmed deletion clears credentials; the old local database remains inaccessible through the app, not securely erased from disk.

AI sharing is independent of cloud storage and progress analytics. Authenticated GET `/api/v1/chat/policy` returns a named provider and versioned disclosure. POST `/api/v1/chat/consent` stores a matching provider/version grant or revocation. External `/api/v1/chat/interpret` requires both that stored grant and its current `aiPolicyId`. Generic server permission cannot authorize AI sharing. Provider/destination/model/version changes require applicable consent again. Requests and every response variant are strictly bounded and validated again before local mutation.


## Read-only coaching snapshot (2026-11-16)

`POST /api/v1/chat/coach` retrieves only the authenticated account's synced records, using a cursor/revision snapshot and the same deterministic personal-context calculation engine as the app. Phone pending/conflict hints disclose incompleteness without uploading local records in the coaching request. New provider consent version2026-11-16 covers profile/history/facts and up to four local conversation turns; cloud consent remains separate. Coaching creates no workout, set or plan. The shared context bridge requires Node 22.18 or newer.
