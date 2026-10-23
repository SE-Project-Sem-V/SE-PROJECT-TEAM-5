# Frontend (React + Vite)

## Run locally
```bash
cd frontend
cp .env.example .env     # mock mode is on by default
npm install
npm run dev              # http://localhost:5173
```
Mock mode lets you log in with any username and chat with fake users (alice, bob, charlie) without a backend.
Set `VITE_USE_MOCK=false` in `.env` once the backend is running.

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
- `GET /api/users?q=text` (assumed): header `Authorization: Bearer <token>`, response `[{ id, username, online }]`.
- Error bodies: `{ error: "message" }` or `{ error: { code, message } }`. The UI shows the message text.

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
