# Backend database and credential security (CHATAPP-38 / CHATAPP-26)

PostgreSQL infrastructure for users, rooms, membership and message persistence.
The server uses the existing PostgreSQL pool for timestamped Socket.IO messages.
JWT WebSocket verification is implemented; registration/login and search/history
endpoints are not. `/api/ping` is a liveness response; `db:check` verifies database
readiness separately.

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
- Set `JWT_SECRET` for server startup as described under credential security below.
- Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` for your personal database.
- Keep `NODE_ENV=development`, `DB_SSL_MODE=disable` only on loopback development.
- Set `DB_ALLOW_SEED=true` when you intentionally want development fixtures.
- Set `TEST_PGDATABASE` to a **different** local database ending in `_test`.

The server and database scripts load `backend/.env` by absolute path; process environment variables take
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
password.** There is no plaintext fixture credential or registration/login API.
CHATAPP-26 supplies shared Argon2id utilities; CHATAPP-7 must connect them to real
registration/login. Never replace an existing user's hash just to make a seed
account accessible. The database seed implementation remains unchanged.

## Credential security (CHATAPP-26)

`security/passwords.js` exports asynchronous `hashPassword(password)` and
`verifyPassword(password, encodedHash)`. New hashes use Argon2id with 19 MiB memory,
two iterations, parallelism one, a 32-byte digest and a fresh library-generated
16-byte salt. The full encoded PHC string belongs in `users.password_hash`;
there is no additional salt column or schema migration.

Passwords must be nonempty, well-formed Unicode strings of at most 1,024 UTF-8
bytes. Spaces, Unicode normalization and all other password characters are
preserved exactly; nothing is trimmed, normalized or truncated. CHATAPP-7 may
apply an agreed registration policy within this bound. Invalid hashing inputs
raise a generic `PasswordInputError`. Verification returns false for invalid
inputs, malformed/unsupported hashes, or a mismatch. Only pass encoded hashes
retrieved from trusted storage to the verifier, never a client-supplied hash.
Library failures are not logged or returned with credential data.

The existing seed hash format is compatible with the verifier, but its discarded
random passwords remain unknown. `bcryptjs` is currently unused and is retained
to avoid an unrelated dependency change; bcrypt hashes are not accepted by these
utilities. Coordinate any future legacy-hash support with the authentication owner.

`security/config.js` validates `JWT_SECRET` both before startup creates a pool and
inside `createChatServer()`. The key must contain at least 32 UTF-8 bytes, with no
whitespace or repeated-character placeholder. These checks do not measure entropy:
provision a key generated from **at least 32 cryptographically random bytes**, such
as those bytes encoded into 64 hex characters, using a trusted secret-management
tool. Keep the same private key across instances/restarts; there is no default,
automatic key generation, trimming, or hashing of the signing key. Changing the key
invalidates existing tokens and needs coordination with CHATAPP-24.

Inject production JWT/database credentials from a secret manager. For local
development, an ignored `.env` is still plaintext on disk: restrict its access and
keep it out of source control, logs, screenshots and shared messages. Do not put
secrets in frontend `VITE_*` settings. `.env.example` intentionally contains blank
credential fields. User password hashing does not replace protecting the runtime
JWT key or the database connection credential.

The final HTTP middleware returns controlled JSON for malformed/oversized bodies,
unsupported encodings and unexpected errors, and a generic 404 without echoing
the requested URL. Error logs contain a fixed label and status only, never raw
errors, request bodies, headers, cookies, query strings or credential fragments.
Register future HTTP routes **above** the final handlers in `createChatServer()`.
If headers are already sent, the response is closed without forwarding the raw
error to Express's default logger. Keep verbose third-party request/debug logging
disabled when handling credentials.

### CHATAPP-7 handoff and TC-SEC-04 acceptance

- Registration must call `hashPassword()` before a parameterized insert into
  `users.password_hash`, and supply the required `display_name`.
- Login must perform the agreed case-insensitive username lookup, then call
  `verifyPassword(submittedPassword, storedHash)`. Use generic credential failures;
  never fall back to plaintext comparison or a second in-memory user store.
- Select public response fields explicitly. Never return/log password hashes or
  submitted passwords, including on validation and database errors. The intended
  login token response remains part of the authentication contract; signing keys
  and database credentials must never be returned.
- Tests here prove utility, configuration, error handling and storage behavior.
  **TC-SEC-04 is not fully accepted until actual registration/login integration
  tests inspect PostgreSQL rows and captured success/failure logs/responses.**

CHATAPP-24 continues to own JWT issuance/verification policy coordination. This
change preserves the existing WebSocket verifier and does not add an expiration
requirement, algorithm allowlist, logout/revocation, or new authentication routes.

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

### Authentication and user directory handoff (CHATAPP-7 / CHATAPP-10)

- Usernames contain 1-64 ASCII letters, digits or underscores. Store the chosen
  casing; normalize lookup input with `trim().toLowerCase()`. The database rejects
  spaces/unsupported characters and case-only duplicates. ASCII avoids conflicting
  Unicode/collation normalization policies. `display_name` supports Unicode.
- Match the index in SQL: `lower(username COLLATE "C") = $1`, passing the normalized
  username as a bound value. A pre-registration lookup is not a substitute for
  handling SQLSTATE `23505` during concurrent registration.
- `password_hash` holds the complete encoded hash including parameters and salt.
  Authentication owns input policy and invokes CHATAPP-26's shared hashing/verifying
  utilities. Coordinate JWTs and logout/session revocation with CHATAPP-24.
  Durable per-session revocation may require a later
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

`npm test` needs no PostgreSQL or configured JWT key. It runs configuration and
credential-security tests: Argon2id salt/verification/input handling, JWT key
validation/startup failures, real HTTP error redaction in development/production,
WebSocket authentication/protected acknowledgements, sanitized message failure
responses, mandatory verified TLS, test/seed safety gates and bounded TCP failures.
Tests generate ephemeral credentials in memory and keep them out of diagnostics.

`npm run test:db` requires a running **local** PostgreSQL instance, role/password
configuration, and a separate pre-created `TEST_PGDATABASE` ending in `_test`.
It deliberately exits nonzero if prerequisites are missing; it never silently
substitutes mocks or uses `PGDATABASE`.

This command runs **both** `test/database.test.js` and
`test/message-handler.test.js`. The messaging suite generates its own temporary
signing key; it does not need a deployment `JWT_SECRET`.

Each suite checks the actual target name, creates a random `chatapp_test_<uuid>`
or `chatapp_message_test_<uuid>` schema, sets an exclusive search path and drops
only its own schema afterward. The database suite
tests connectivity, real migrations/concurrent migration runs, checksum tampering,
DDL rollback, repeatable/concurrent seeds, preserved data/hashes, PK/FK/username
constraints, lookup/search queries, memberships, message insertion/history,
timestamps, concurrent deduplication, profile updates and transaction rollback.
It reconnects through a new pool to verify data survives connection teardown.
The credential storage test inserts only an Argon2id hash, retrieves it through
a new connection, verifies correct/wrong passwords and checks a public-field
projection. The messaging suite checks persistence, database-generated timestamps,
delivery/acknowledgement payloads, retries and rejected message operations.
Database-server restart durability is a separate manual check below.

`.github/workflows/backend-db-ci.yml` starts disposable PostgreSQL 18 with a random
masked password, runs `npm test` and `npm run test:db` (including messaging), then
removes its test container and volume.
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
