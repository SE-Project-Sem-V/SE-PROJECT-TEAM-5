# Backend database foundation (CHATAPP-38)

PostgreSQL infrastructure for users, rooms, membership and message persistence.
The existing Express/Socket.IO scaffold and `/api/ping` remain independent of the
database. This task does not implement authentication, search/history endpoints,
presence, or message routing. `db:check` verifies database readiness separately.

## Prerequisites

- Node.js 24 LTS and npm (the database CI uses Node 24).
- PostgreSQL 18, either a normal local installation **or** Docker with Compose v2.
- A private database role/password, one personal development database and a
  separate disposable test database. Do not point tests at a teammate's database.
- `argon2` normally installs a prebuilt native binary on supported platforms. If
  none is available, its build requires the toolchain described by
  [node-argon2](https://github.com/ranisalt/node-argon2#before-installing).

## Configure and install

From the repository root, in PowerShell:

```powershell
cd backend
Copy-Item .env.example .env
npm ci
```

Edit the ignored `backend/.env` locally:

- Set a private, nonempty `PGPASSWORD`; no password is supplied in this repository.
- Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` for your personal database.
- Keep `NODE_ENV=development`, `DB_SSL_MODE=disable` only on loopback development.
- Set `DB_ALLOW_SEED=true` when you intentionally want development fixtures.
- Set `TEST_PGDATABASE` to a **different** local database ending in `_test`.

Scripts load `backend/.env` by absolute path; process environment variables take
precedence. `.env`, `.env.test`, npm caches, node_modules and generated logs are
ignored. Never paste populated connection settings into Git, Jira or logs.
There is no `DATABASE_URL` support: use the explicit PG* fields. `DATABASE_URL`,
`PGSSLMODE`, `PGOPTIONS` and `PGSERVICE` overrides are rejected to keep TLS and
schema configuration predictable.

Remote and production connections require `DB_SSL_MODE=verify-full`, which checks
the server certificate and hostname. Set `DB_SSL_CA_FILE` if a private CA is
required; a relative path resolves from `backend/`. Certificate verification is
never disabled for remote connections. A deployment should use separate migration
and runtime roles, granting the runtime role only the required table privileges.

### Option A: normal local PostgreSQL (Docker not required)

Install/start PostgreSQL 18 from the official
[Windows download page](https://www.postgresql.org/download/windows/) or your
platform's PostgreSQL packages. Ensure `psql` and `createdb` are on PATH (Windows
normally installs them in `C:\Program Files\PostgreSQL\18\bin`).

As your local PostgreSQL administrator, connect using a hidden password prompt:

```powershell
psql -h 127.0.0.1 -U postgres -W -d postgres
```

Inside `psql`, create a role and assign its password interactively. These commands
contain no credentials. If the role/databases already exist, use your existing
personal resources rather than recreating or dropping them.

```sql
CREATE ROLE chatapp LOGIN;
\password chatapp
CREATE DATABASE chatapp_dev OWNER chatapp;
CREATE DATABASE chatapp_test OWNER chatapp;
\quit
```

Enter that private role password in `backend/.env`. Native installations may use
a different administrator role; ask the owner rather than changing shared roles.

### Option B: optional Docker Compose

With the populated `.env` in `backend/`:

```powershell
docker compose --env-file .env up -d --wait db
docker compose --env-file .env exec db createdb -U chatapp -O chatapp chatapp_test
```

The second command creates only the test database; run it once, and substitute
your chosen `PGUSER`/`TEST_PGDATABASE` names if different. Compose provisions
`PGDATABASE` on its first startup. The port binds only to `127.0.0.1`, and a named
volume preserves data. PostgreSQL 18 uses `/var/lib/postgresql` as the volume mount.
The Compose role owns this **local development** instance; it is not a deployment
privilege template.

Changing `.env` credentials does not change credentials inside an initialized
volume. Use an authenticated PostgreSQL password change; do not delete the volume
to resolve a configuration mismatch. To stop without removing data:

```powershell
docker compose --env-file .env stop db
```

## Migrate, seed and verify

From `backend/` after PostgreSQL is ready:

```powershell
npm run db:migrate
npm run db:seed
npm run db:check
npm test
npm run test:db
```

- **Migrate:** applies ordered `db/migrations/NNN_description.sql` files within a
  transaction and a database/schema-scoped advisory lock. `schema_migrations`
  records SHA-256 checksums and timestamps. Rerunning is a no-op. Applied files
  cannot be changed, removed or reordered; add a higher-numbered file. CRLF/LF
  differences do not change checksums. On error, DDL and bookkeeping roll back
  together. There is no automatic reset or down migration.
- **Seed:** explicitly requires `DB_ALLOW_SEED=true`, development/test mode, a
  loopback host and a database ending in `_dev` or `_test`. It also checks the
  actual connected database name. One transaction and an advisory lock serialize
  seed runs. Stable fixture IDs prevent duplicates. Existing users, password
  hashes, profile edits and unrelated rows are preserved. Conflicting identities,
  rooms/messages or departed fixture memberships fail instead of being replaced.
- **Check:** verifies connectivity, applied migration checksums and readable
  columns on all four application tables. A ping response alone proves none of
  these. Errors exit nonzero with diagnostics that omit raw pg error details,
  connection strings, query parameters, hashes and message content.

Fixtures contain `alice`, `bob`, `charlie`; one Alice/Bob direct room; one group
room with all three users; five memberships; and four messages. User, room and
message IDs are stable UUIDs declared in `db/seed.js`; timestamps are generated
when the data is first inserted.

Each new seed user receives an independently salted Argon2id PHC hash using
19 MiB memory, two iterations and parallelism one. Its password is random bytes
generated in memory and then discarded. **Seed accounts have no known login
password.** There is no plaintext fixture credential or password-verification API.
CHATAPP-26 can later use the standard hash format with `argon2.verify` and create
test logins through its own registration flow. Never replace an existing user's
hash just to make a seed account accessible.

## Database model and integration contract

| Table | Keys and purpose |
| --- | --- |
| `users` | UUID PK; unique index on lowercase ASCII username; password hash; display name (1-64 characters, nonblank); optional status message (up to 280); creation/update timestamps. A trigger maintains `updated_at` on writes. |
| `chat_rooms` | UUID PK; `direct`/`group` kind; creator FK to users; timestamp. Direct rooms have two ordered, distinct user FKs and a unique pair; creator must be one of the pair. Group rooms have a nonblank name (up to 100 characters). |
| `room_members` | Composite PK `(room_id,user_id)`; FKs to rooms/users; joined/optional left timestamps. An index starting with `user_id` supports listing a user's rooms. |
| `messages` | UUID PK; room/sender FKs; composite FK to the sender's membership; nonblank text; nonblank `client_id` up to 128 characters; database timestamp; unique `(sender_id,client_id)`; history index `(room_id,created_at,id)`. |

All timestamps use `TIMESTAMPTZ`. Foreign keys restrict deletion rather than
cascading away conversations. Keep departed membership records using `left_at`.
There is no persisted `online` Boolean: connection state belongs to the presence
module. There are no session tokens or JWT secrets in these tables.

### Authentication and user directory handoff (CHATAPP-26 / CHATAPP-10)

- Usernames contain 1-64 ASCII letters, digits or underscores. Store the chosen
  casing; normalize lookup input with `trim().toLowerCase()`. The database rejects
  spaces/unsupported characters and case-only duplicates. ASCII avoids conflicting
  Unicode/collation normalization policies. `display_name` supports Unicode.
- Match the index in SQL: `lower(username COLLATE "C") = $1`, passing the normalized
  username as a bound value. A pre-registration lookup is not a substitute for
  handling SQLSTATE `23505` during concurrent registration.
- `password_hash` holds the complete encoded hash including parameters and salt.
  Authentication owns input policy, hashing/verifying real passwords, JWTs and
  logout/session revocation. Durable per-session revocation may require a later
  migration; these four tables do not provide it.
- Search can use parameterized `ILIKE $1`, with `%`, `_` and backslash escaped for
  literal substring matching, and a bounded limit. The lowercase identity index
  does not accelerate arbitrary substring searches. Select only public fields
  and add live `online` from presence to return `{ id, username, online }`.

### Rooms and messaging handoff

- Reuse one pool per process with `createPool()` from `db/pool.js`. Queries use
  `pool.query(sql, values)`; multi-statement work uses `withTransaction(pool, fn)`
  and the supplied client for every query. Close with `pool.end()` on shutdown.
  Configuration has bounded pool size, connection timeout, statement/lock timeout,
  verified remote TLS, and an idle-connection error handler.
- The room service must create the room and memberships in **one transaction**.
  Direct-room creation orders the pair consistently and handles unique-pair
  races by looking up the existing room. The service must enforce exactly the two
  direct participants, active creator membership, membership changes/permissions,
  and configurable room size. These cross-row authorization rules are not fully
  enforced by row constraints.
- The composite message FK proves a membership record exists; it does **not** prove
  the sender is currently active. Check `left_at IS NULL` for sends/history and
  coordinate sends with membership updates using the same row lock/transaction.
  The authenticated context supplies the sender; never trust a payload sender ID.
- Keep the frontend's `{ to, text, clientId }` input: resolve `to` to a direct room.
  For group messages use `roomId`. On output map `sender_id -> userId`,
  `content -> text`, `created_at -> timestamp` (ISO string), `room_id -> roomId`.
  Derive direct `to` from the room pair. UUIDs already serialize as strings.
- Retry uniqueness is scoped to the sender across **all** rooms. On a conflict,
  fetch the original message, compare the room and content, and return its original
  ID/timestamp only if they match; reject conflicting reuse. The schema supplies
  the unique constraint, not a complete idempotent send handler. Acknowledge only
  after commit. A commit/emit crash still needs routing/recovery handling.
- The frontend currently generates `clientId` with `Date.now()`. Its owner should
  consider `crypto.randomUUID()` to avoid same-millisecond/multiple-tab collisions.
- The database rejects whitespace-only content; the application enforces the
  configurable maximum (frontend default 1,000). Agree Unicode length semantics
  with the frontend. A hardcoded database upper bound would conflict with the
  SRS's configurable setting, so `content` is `TEXT`.
- Retrieve history with bounded keyset pagination over `(created_at,id)`. The ID
  breaks timestamp ties deterministically; this is not a strict global send-order
  guarantee. Retention, rejoin/previous-history access, and durable unread state
  need later feature decisions/migrations.

The frontend defaults to port 3000; the server defaults to 5000. Its owner must
set `VITE_API_URL` appropriately when real APIs exist. Keep mock mode enabled until
those features are implemented. Agree `newMessage` versus `receiveMessage` with
the messaging owner; CHATAPP-38 changes neither event names nor payload contracts.

## Tests and isolation

`npm test` needs no PostgreSQL. It tests credential/config validation, mandatory
verified TLS, test/seed safety gates, bounded real TCP connection failure and
redaction of error details.

`npm run test:db` requires a running **local** PostgreSQL instance, role/password
configuration, and a separate pre-created `TEST_PGDATABASE` ending in `_test`.
It deliberately exits nonzero if prerequisites are missing; it never silently
substitutes mocks or uses `PGDATABASE`.

The suite checks the actual target name, creates a random `chatapp_test_<uuid>`
schema, sets an exclusive search path and drops only that schema afterward. It
tests connectivity, real migrations/concurrent migration runs, checksum tampering,
DDL rollback, repeatable/concurrent seeds, preserved data/hashes, PK/FK/username
constraints, lookup/search queries, memberships, message insertion/history,
timestamps, concurrent deduplication, profile updates and transaction rollback.
It reconnects through a new pool to verify data survives connection teardown.
Database-server restart durability is a separate manual check below.

`.github/workflows/backend-db-ci.yml` starts disposable PostgreSQL 18 with a random
masked password, runs both suites, then removes its test container and volume.
The existing frontend workflow is unchanged. CI is configured here, but is only
proven after its workflow actually runs.

### Manual persistence check

After migration/seeding/checking, query the four fixture messages in `psql`:

```powershell
psql -h 127.0.0.1 -U chatapp -W -d chatapp_dev -c "SELECT id, room_id, created_at FROM messages ORDER BY created_at, id;"
docker compose --env-file .env restart db
docker compose --env-file .env up -d --wait db
npm run db:check
psql -h 127.0.0.1 -U chatapp -W -d chatapp_dev -c "SELECT id, room_id, created_at FROM messages ORDER BY created_at, id;"
```

For native PostgreSQL, restart your **personal** instance through its normal
service controls instead of the Docker commands. The same IDs/timestamps must
remain. Do not restart a shared instance without coordinating with its owner.

## Scope and review

The schema follows SRS CHAT-F-001/005/008/010/011/016 and PRJ-SR-004/005, SAD 3.6
(relational PostgreSQL/MySQL option) and 4.3 (auth/message contracts), and the STP's
persistence/credential checks. This foundation supports those features; it does
not claim their APIs or acceptance flows are complete.

Coordinate package/lockfile merges and migration numbering with Anand and the
other developers. Do not overwrite an applied migration or introduce a second
user store/connection pool. This branch changes no frontend, auth routes, Socket.IO
handlers, Jira state or Git publication state.
