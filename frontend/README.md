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
- Search errors: 400 invalid query, 401 missing/invalid authentication or nonexistent caller, 500 database/server failure, with `{ status: "error", message: "controlled message" }`. The adapter also retains `{ error: "message" }` and `{ error: { code, message } }` compatibility. The list keeps its generic error state.

Socket.IO
- The JWT is sent in the handshake: `auth: { token }` (SAD flow 1).
- Client to server: `sendMessage` with `{ to, text }` (SAD 4.3 uses `roomId`; the UI uses `to` for a one-to-one chat, group chats will use `roomId`). The client does not send a timestamp. The server answers through the acknowledgement callback with `{ ok: true, message: { id, userId, to, text, timestamp } }` or `{ ok: false, error }`.
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
