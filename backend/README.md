# Backend database, credential security and user search (CHATAPP-38 / CHATAPP-26 / CHATAPP-10)

PostgreSQL infrastructure for users, rooms, membership and message persistence.
The server uses the existing PostgreSQL pool for timestamped Socket.IO messages.
JWT WebSocket verification and authenticated user search are implemented;
registration/login and history endpoints are not. `/api/ping` is a liveness response; `db:check` verifies database
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
the requested URL. Failure logs are single-line JSON with allowlisted event names,
codes and metadata, never raw errors, request bodies, headers, cookies, query strings
or credential fragments.
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
- Search uses parameterized `ILIKE` with an explicit `!` escape character: `!`,
  `%` and `_` are escaped, and backslash is literal. The lowercase identity index
  does not accelerate arbitrary substring searches. Return only public fields;
  presence integration must supply real connection state before adding `online`.

## User search (CHATAPP-10 / CHAT-F-005)

`GET /api/users?q=ali` requires `Authorization: Bearer <session-token>` and returns:

```json
{"users":[{"id":"10000000-0000-4000-8000-000000000002","username":"Alina"}]}
```

The example is illustrative. Results come from registered PostgreSQL users,
exclude the authenticated caller, and contain only `id` and `username`. Missing,
empty or whitespace-only `q`, and queries with no matches, return HTTP 200 with
`{"users":[]}` (TC-SEARCH-02). Selection remains a frontend action that opens the
existing chat panel. Search creates no rooms, memberships or messages.

The endpoint trims whitespace and accepts a single `q` of at most 64 JavaScript
string code units, matching the frontend input limit. Matching is a case-insensitive
literal substring of `username`, not `display_name`. Internal ASCII control
characters, malformed percent/UTF-8 encoding, repeated/structured `q` and unknown
parameters are rejected with 400. Results are ordered by lowercase username using
the C collation, then UUID, with a fixed limit of 20. Refine the query for more
specific results; there is no pagination. The query, caller UUID and limit are
bound parameters, and the response explicitly projects public fields.

`middleware/require-auth.js` protects HTTP requests independently of Socket.IO.
It accepts exactly one Bearer authorization header, verifies an HS256 signature
(the project's default signing algorithm), and checks `exp`/`nbf` when present.
It requires a UUID `sub` and checks the account exists on every request, using
the database's canonical UUID as the caller identity. It never accepts a caller
ID or token from query parameters. There is no token issuance or logout/revocation
implementation here. CHATAPP-7/24 must issue expiring tokens with the same private
key and UUID subject and coordinate any future algorithm/revocation policy.
The existing WebSocket verification policy is unchanged; CHATAPP-21 adds error codes.

Authentication failures use HTTP 401, `WWW-Authenticate: Bearer`, and
`{"status":"error","code":"AUTH_REQUIRED","message":"Authentication required."}`
(or `AUTH_INVALID`/`AUTH_EXPIRED` as applicable). Invalid input uses
400 with a fixed validation message. Database/unexpected failures flow through
CHATAPP-26's final handler and return 500 with `Internal server error.`; logs contain
only its fixed label/status. Directory responses and errors use `Cache-Control:
no-store`. Tokens, hashes, credentials and private profile fields are never returned.

No online status is inferred from database records. The frontend treats missing
presence as unknown and displays "Presence unavailable". CHATAPP-7 is still needed
for real registration/login through the UI; mock tokens cannot access this endpoint.
CHATAPP-11 owns creating/reusing direct rooms and memberships before sending to a
new recipient. Existing messaging still requires a direct room with active members.

### Group room database operations (CHATAPP-50)

`db/rooms.js` reuses the existing tables and `withTransaction()`; it creates no
pool, table or migration. Its exports are trusted database primitives, **not**
HTTP endpoints or authorization checks:

| Helper | Behavior |
| --- | --- |
| `createGroupRoom(pool, { name, createdBy, memberIds = [] })` | Atomically inserts a group and active memberships for its creator and selected users. Returns the room's `id`, `kind`, `name`, `created_by`, `created_at` and active `members`. Existing schema constraints validate names and user references. |
| `addGroupMembers(pool, roomId, memberIds)` | Atomically adds a batch and returns the full active member list. Locks the room and existing requested memberships. Repeated active memberships preserve their timestamps; repeated UUIDs, including different casing, are deduplicated. |
| `isActiveMember(db, roomId, userId)` | Returns a Boolean using `left_at IS NULL`; absent rooms/users/memberships return false. Accepts a pool or transaction client. |
| `listRoomMembers(db, roomId, { includeDeparted = false } = {})` | Returns `id`, `username`, `joined_at`, `left_at`, ordered by lowercase username with C collation, then UUID. Departed memberships require explicit opt-in; unknown rooms return an empty list. Accepts a pool or transaction client. |

Writes use bound parameters and roll back together on failure. They never update
an existing membership. `addGroupMembers` raises `RoomOperationError` with code
`ROOM_NOT_FOUND`, `GROUP_ROOM_REQUIRED` (for any direct room), or
`MEMBER_REJOIN_REQUIRED` (if any requested member has departed). A rejected batch
adds nobody and preserves departed records. PostgreSQL validation/FK errors
propagate to the caller; use the existing sanitized error handling rather than
returning/logging raw errors. Active membership reads are point-in-time checks,
not a substitute for transactional membership locks when sending messages.

The merged `frontend/src/groups.js` explicitly labels its API contract as assumed:

- `GET /api/rooms` -> `{ rooms: [{ id, name, members: [{ id, username }] }] }`,
  restricted to the caller's groups.
- `POST /api/rooms` with `{ name, memberIds }` -> `{ room: { id, name, members } }`.
  The authenticated identity must supply `createdBy`; it is not in the payload.
- `GET /api/rooms/:roomId/messages` -> `{ messages: [{ id, from, roomId, content, timestamp }] }`.
- Socket input `sendMessage { roomId, text, clientId }`, output `newMessage` with
  `roomId`. The existing backend handler currently accepts direct recipients only.

`NewGroupForm.jsx` trims names, limits them to 100 characters, excludes the creator
from selection and requires at least one selected user. `GroupList.jsx` uses
`members.length` for its count. The creation helper's result can supply the
assumed POST response; the route should explicitly project its public API fields.
Room-directory queries, group HTTP routes and group message handling remain with
the integrating tasks (frontend references CHATAPP-15/16). No separate invite or
rejoin endpoint contract is specified by these frontend files.

**Decisions needed from Anand before service integration:** who may create groups,
invite/add/remove members or inspect membership/history; whether invitations need
acceptance; minimum/maximum group size; whether departed members may rejoin, who
may authorize that and what history they may see. These helpers enforce no
invented permission/size policy and can store a creator-only group; the service
must apply the agreed rules before calling them. Until rejoin behavior is agreed,
additions of departed members explicitly fail.

Inspection found schema/seed fixtures and teammate direct-room operations, but no
existing reusable group database operations in the checked local Git refs. The
existing direct-conversation route in `routes/users.js` uses an upsert that resets
`left_at = NULL`. That pre-existing direct reactivation behavior needs an explicit
decision from Anand and its owner; CHATAPP-50 leaves that route unchanged. The new
group helper rejects every direct room, including attempts to add a third user.
There is no new database-wide trigger constraining raw membership SQL.

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

The frontend's `.env.example` and local fallback use port 5000, matching the
server default. Set `VITE_API_URL` in the ignored frontend `.env` for a different
backend port or HTTPS deployment, and restart Vite. Older local configurations
pointing to port 3000 must be updated privately. Keep mock mode enabled until
CHATAPP-7 provides real login. CHATAPP-10 changes no socket event or message contract.

## Tests and isolation

`npm test` needs no PostgreSQL or configured JWT key. It runs configuration,
credential-security, authentication, user-search, message-validation and standardized-error tests:
Argon2id salt/verification/input handling, JWT key
validation/startup failures, real HTTP error redaction in development/production,
WebSocket authentication/protected acknowledgements, sanitized message failure
responses, mandatory verified TLS, test/seed safety gates and bounded TCP failures.
Search tests cover bearer authentication/subjects, malformed query parameters,
bounded input, literal wildcard escaping, public fields and safe failure responses.
Tests generate ephemeral credentials in memory and keep them out of diagnostics.

`npm run test:db` requires a running **local** PostgreSQL instance, role/password
configuration, and a separate pre-created `TEST_PGDATABASE` ending in `_test`.
It deliberately exits nonzero if prerequisites are missing; it never silently
substitutes mocks or uses `PGDATABASE`.

This command runs `test/database.test.js`, `test/message-handler.test.js`,
`test/user-search.database.test.js`, and `test/rooms.database.test.js`. HTTP and messaging tests generate temporary
signing keys; they do not need a deployment `JWT_SECRET`.

Each suite checks the actual target name, creates a random `chatapp_test_<uuid>`
or `chatapp_message_test_<uuid>`, `chatapp_search_test_<uuid>` or `chatapp_rooms_test_<uuid>` schema, sets an exclusive search path and drops
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
The search suite exercises real HTTP requests against migrated PostgreSQL fixtures:
case-insensitive partial matching, caller exclusion, empty/no-match results,
literal wildcard and SQL-injection inputs, account existence, public-field
projection, deterministic ordering and the 20-result cap. It creates/deletes only
its own temporary fixture data and schema, never development or shared records.
The room suite tests atomic group/creator creation, duplicate/concurrent additions,
invalid references and rollback, schema name constraints, parameterized names,
active/departed membership, stable public member listings and direct-room rejection.
Database-server restart durability is a separate manual check below.

## Standardized errors (CHATAPP-21 / CHAT-F-015)

`errors.js` owns the public catalogue, `AppError`, safe normalization and transport
builders. Messages come from the catalogue or named controlled variants, never
from submitted values or arbitrary exceptions. The normalizer recognizes only
errors constructed by that module; forged `code`, `status`, `message` fields or
an `AppError` prototype do not make an exception public. Unknown failures become
`INTERNAL_ERROR`. Raw SQLSTATE codes are not a public API.

HTTP failures preserve their status and existing message fields:

```json
{"status":"error","code":"AUTH_REQUIRED","message":"Authentication required."}
```

Socket.IO connection rejections still use `connect_error` with a controlled
`Error.message`. They also carry `error.data = { code, message }`. Existing texts
such as `Authentication required` and `Invalid or expired token` are preserved.
`AUTH_EXPIRED` is selected only for `jsonwebtoken.TokenExpiredError`, after normal
JWT verification; other JWT failures use `AUTH_INVALID`. HTTP authentication keeps
its generic `Authentication required.` text and Bearer header for all three codes.

Failed message acknowledgements use:

```json
{"ok":false,"code":"ROOM_FORBIDDEN","message":"Both users must be active members of the conversation.","error":"Both users must be active members of the conversation."}
```

`error` remains a string compatibility alias generated from the same source as
`message`. Successful ACKs remain exactly `{ ok: true, message: persistedMessage }`.
Persistence, delivery events, authoritative timestamps, retries and membership
authorization are unchanged. CHATAPP-27's validator still returns a controlled
string or `null`; all its rules remain intact. Its failures use `INVALID_MESSAGE`.

| Public code | HTTP status / equivalent | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Required authentication absent |
| `AUTH_INVALID` | 401 | Invalid authentication, subject or missing HTTP account |
| `AUTH_EXPIRED` | 401 | Verified token expiration |
| `INVALID_CREDENTIALS` | 401 | Unknown username or incorrect password, indistinguishable |
| `INVALID_INPUT` | 400 | Invalid auth/search/conversation input or malformed request size/abort |
| `INVALID_MESSAGE` | 400 equivalent | Existing message payload rules rejected the input |
| `INVALID_JSON` | 400 | Malformed JSON |
| `PAYLOAD_TOO_LARGE` | 413 | HTTP request body exceeds the parser limit |
| `UNSUPPORTED_ENCODING` | 415 | Unsupported request encoding or charset |
| `USERNAME_TAKEN` | 409 | Username conflict during registration |
| `RECIPIENT_NOT_FOUND` | 404 | Conversation creation establishes recipient absence |
| `CONVERSATION_NOT_FOUND` | 404 equivalent | Sending found no direct room for the pair |
| `ROOM_FORBIDDEN` | 403 equivalent | Both participants are not active members |
| `CLIENT_ID_CONFLICT` | 409 equivalent | Retry ID reused with different room/content |
| `NOT_FOUND` | 404 | Unknown HTTP route |
| `INTERNAL_ERROR` | 500 equivalent | Unrecognized server/database failure |

Socket ACKs do not acquire an HTTP status field. The unexpected message-save
variant retains `Message could not be saved. Please try again.`; HTTP unexpected
failures retain `Internal server error.`. Clients should branch on codes, not prose.

Current semantics are deliberate: a missing recipient during sending and an
absent direct conversation both produce `CONVERSATION_NOT_FOUND`; no additional
account lookup was added. Offline presence is not a message rejection. History
still returns `{ messages: [] }` when its existing query returns no authorized
rows. No new authorization/disclosure distinctions or group endpoints are added.

CHATAPP-50 database errors remain separate: `ROOM_NOT_FOUND`, `GROUP_ROOM_REQUIRED`
and `MEMBER_REJOIN_REQUIRED` are internal `RoomOperationError` codes. Their future
API/service adapter must explicitly recognize that type and choose controlled
public mappings. Do not serialize these errors or PostgreSQL exceptions directly.

CHATAPP-8 still owns logout, session revocation and connected-session expiration.
CHATAPP-28 adds `logging.js` for controlled failure records. It accepts only fixed
event/code combinations and the listed metadata for each event. Example:

```json
{"level":"error","event":"message.save.failed","code":"INTERNAL_ERROR","scope":"group"}
```

HTTP failures use `http.request.failed` with a catalogue code and status; group
operations use `group.operation.failed` with a fixed internal code and status.
Socket authentication uses `auth.socket.failed`. Message handling uses
`message.invalid`, `message.rejected`, `message.save.failed`,
`message.ack.failed`, and `message.broadcast.failed`, with `scope` set to
`direct` or `group`. Failed ping acknowledgements use `socket.ack.failed`.
Presence emit and join failures use
`presence.update.failed` with a fixed operation. Database idle and CLI failures
use `database.idle.failed` or `database.command.failed` with a fixed diagnostic
category. Startup, shutdown and fatal failures use `server.start.failed`,
`server.shutdown.failed`, and `server.fatal`. No event includes a username,
user/socket/client ID, message content, token, SQL, raw URL or exception detail.
Fatal handlers are installed only when `server.js` is run directly.

### TC-ERR-01 evidence

`test/errors.test.js` verifies catalogue consistency, compatibility aliases and
unknown/mutated/forged error sanitization. `test/http-errors.test.js` exercises real
HTTP requests with injected pools for auth, validation, duplicate users, missing
recipients, parser failures and exception spoofing. `test/socket-errors.test.js`
exercises real Socket.IO connections/events with injected persistence for auth,
payload rejection, membership denial, retry conflicts, safe failures and unchanged
successful ACK/delivery. Existing security probes continue capturing responses
and logs in development and production modes. No deployment keys are needed.

The isolated PostgreSQL messaging suite additionally verifies `ROOM_FORBIDDEN`
does not insert a message, alongside timestamp, persistence and retry regression
coverage. The search and CHATAPP-50 room suites remain enabled.

Local verification on 2026-10-28: backend `npm test` **66 passed, 0 failed/skipped**;
`npm run test:db` **47 passed, 0 failed/skipped** (43 cases plus four parent tests);
frontend **33 passed, 0 failed/skipped**, lint and production build passed. Test
schemas were cleaned up and development records were not modified. These are local
results, not a claim that CI has run on this uncommitted change.

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
user store/connection pool. User search adds HTTP authentication and small frontend
adapter/list changes without altering registration/login, Socket.IO handlers,
schema migrations or room/message creation behavior.
