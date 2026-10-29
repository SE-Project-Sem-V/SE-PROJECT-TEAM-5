# Frontend (React + Vite)

## Run locally
```bash
cd frontend
cp .env.example .env     # mock mode is on by default
npm install
npm run dev              # http://localhost:5173
```
Mock mode lets you log in with any username and chat with fake users (alice, bob, charlie) without a backend.
Set `VITE_USE_MOCK=false` and `VITE_API_URL=http://localhost:5000` in the ignored
local `.env` for real APIs. The URL is configurable for other ports and HTTPS
deployments; the local fallback also uses port 5000. Restart Vite after editing
environment settings. Never put backend credentials or signing keys in `VITE_*`.
CHATAPP-7 registration/login is still needed to obtain a real session through the
UI; mock session tokens are not accepted by the backend. Keep mock mode for UI
development until that integration is available.

## Checks (also run by CI)
```bash
npm run lint && npm test && npm run build
```

## Backend contract the UI expects
Items marked (SAD) come from SAD section 4.3. Items marked (assumed) are not in the SAD yet: agree them with the backend developer and update `src/api.js` / `src/socket.js` if they differ.

REST
- `POST /api/auth/login` (SAD): body `{ username, password }`, response `{ status: "ok", token, userId }`. Errors: 401 invalid credentials, 400 bad request.
- `POST /api/auth/register` (assumed): same body. Response either the same as login, or just `{ status: "ok" }` (the UI then logs in).
- `POST /api/auth/logout` (assumed): header `Authorization: Bearer <token>`. Must invalidate the session and its socket (CHAT-F-002).
- `GET /api/users?q=text` (CHATAPP-10): header `Authorization: Bearer <token>`, response `{ users: [{ id, username }] }`. Case-insensitive literal username substring search, trimmed query of at most 64 characters, at most 20 results sorted by lowercase username then ID. The caller is excluded. Empty/no-match queries return `{ users: [] }`; arrays, repeated parameters, malformed encoding, control characters and extra parameters are rejected. No pagination or display-name search is implemented.
- Presence is unavailable from this endpoint. The adapter represents it as `online: null` and the list displays "Presence unavailable" without an offline indicator. Explicit mock/presence booleans still display Online/Offline. Selecting a result continues opening the existing chat panel; it does not create a direct room (CHATAPP-11).
- Search errors: 400 invalid query, 401 missing/invalid authentication or nonexistent caller, 500 database/server failure, with `{ status: "error", code: "ERROR_CODE", message: "controlled message" }`. The adapter also retains `{ error: "message" }` and `{ error: { code, message } }` compatibility. The list keeps its generic error state.

Socket.IO
- The JWT is sent in the handshake: `auth: { token }` (SAD flow 1).
- Client to server: direct `sendMessage` with `{ to, text, clientId }`. The client does not send a timestamp. The server answers with `{ ok: true, message: { id, userId, to, roomId, text, timestamp } }` or `{ ok: false, code, message, error }`, where `error` remains a string equal to `message`. Group payloads are a future backend contract and are still rejected by current validation.
- Server to client: `newMessage` with `{ id, userId, to, roomId?, text, timestamp }` (SAD 4.3). Note that SAD flow 2 calls this event `receiveMessage`. The names live in `EVENTS` in `src/config.js`.
- To meet CHAT-NF-003 (detect a closed connection within 10 s) the server must set Socket.IO `pingInterval` and `pingTimeout` to about 5000 ms each. The defaults (25 s and 20 s) are too slow.
- Non-local traffic must use `https://` / `wss://` (PRJ-SR-001). The UI refuses plain http outside localhost.

## Module map (SAD 3.3 / CHAT-NF-006)
- ClientUI: `src/components/`, `src/App.jsx`
- ReconnectManager: `src/reconnectManager.js`
- WebSocket client: `src/socket.js`
- REST client: `src/api.js`
- Message mapping: `src/messages.js`
- Test hooks for QA (Selenium): `data-testid` attributes on the main controls

## Standardized errors (CHATAPP-21 / TC-ERR-01)

HTTP errors add `code` while retaining `status: "error"` and the existing safe
`message`, for example:

```json
{"status":"error","code":"AUTH_EXPIRED","message":"Authentication required."}
```

Socket connection failures retain `connect_error` and its safe `error.message`;
`error.data` additionally contains `{ code, message }`. Failed message ACKs are:

```json
{"ok":false,"code":"INVALID_MESSAGE","message":"Invalid message payload.","error":"Invalid message payload."}
```

The legacy string `error` and the new `message` always agree. Successful HTTP
responses, successful message ACKs and `newMessage` payloads are unchanged.
`api.js`, `groups.js` and `socket.js` can already read these messages; no component
changes are required. Adapters currently throw ordinary `Error` objects and do not
retain public codes. Code-driven logout/reauthentication UX must be coordinated
with CHATAPP-8; connection error codes do not themselves implement revocation.

Public codes are `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_EXPIRED`,
`INVALID_CREDENTIALS`, `INVALID_INPUT`, `INVALID_MESSAGE`, `INVALID_JSON`,
`PAYLOAD_TOO_LARGE`, `UNSUPPORTED_ENCODING`, `USERNAME_TAKEN`,
`RECIPIENT_NOT_FOUND`, `CONVERSATION_NOT_FOUND`, `ROOM_FORBIDDEN`,
`CLIENT_ID_CONFLICT`, `NOT_FOUND` and `INTERNAL_ERROR`. See `backend/README.md`
for meanings and HTTP status mappings. Do not equate an offline recipient with a
failed persisted message, or a transport timeout with a definitive server rejection.

Adapter regression evidence: `api.users.test.js` checks additive HTTP codes and
readable messages; `socket.test.js` checks legacy/additive/object failures,
unchanged successful normalization and controlled timeout messages. On 2026-10-28,
all 33 frontend tests passed; lint and the production build passed. Backend
TC-ERR-01 evidence and test-database isolation are documented in its README.
