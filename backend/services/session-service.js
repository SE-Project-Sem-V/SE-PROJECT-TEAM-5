const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { AppError } = require("../errors");
const { insertSession, findSession, markRevoked } = require("../db/sessions");
const { withTransaction } = require("../db/pool");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = value => typeof value === "string" && UUID.test(value);

async function issueSession(db, userId, jwtSecret) {
  const id = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const token = jwt.sign({ sub: userId, jti: id, exp }, jwtSecret, { algorithm: "HS256" });
  await insertSession(db, { id, userId, expiresAt: new Date(exp * 1000) });
  return token;
}

async function assertActiveSession(db, session, lock = false) {
  if (!session || !validId(session.id) || !validId(session.userId) ||
      !Number.isSafeInteger(session.exp) || session.exp <= 0) throw new AppError("AUTH_INVALID", "http");
  const row = await findSession(db, session.id, session.userId, lock);
  if (!row || row.id?.toLowerCase() !== session.id.toLowerCase() ||
      row.user_id?.toLowerCase() !== session.userId.toLowerCase()) throw new AppError("AUTH_INVALID", "http");
  if (row.revoked_at !== null) throw new AppError("AUTH_REVOKED", "http");
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt)) throw new AppError("AUTH_INVALID", "http");
  if (expiresAt <= Date.now() || session.exp * 1000 <= Date.now()) throw new AppError("AUTH_EXPIRED", "http");
  return { id: row.id, userId: row.user_id, exp: session.exp, expiresAt: Math.min(expiresAt, session.exp * 1000) };
}

async function authenticateSession(db, token, jwtSecret) {
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
  } catch (error) {
    throw new AppError(error instanceof jwt.TokenExpiredError ? "AUTH_EXPIRED" : "AUTH_INVALID", "http");
  }
  if (!claims || !validId(claims.sub) || !validId(claims.jti) ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= 0) throw new AppError("AUTH_INVALID", "payload");
  return assertActiveSession(db, { id: claims.jti, userId: claims.sub, exp: claims.exp });
}

async function revokeSession(pool, session) {
  await withTransaction(pool, async client => {
    // Exclusive revocation conflicts with message transactions' session SHARE locks.
    await client.query("SELECT id FROM user_sessions WHERE id = $1::uuid FOR UPDATE", [session.id]);
    await assertActiveSession(client, session);
    if (await markRevoked(client, session.id, session.userId) !== 1) throw new AppError("AUTH_REVOKED", "http");
  });
}

module.exports = { issueSession, authenticateSession, assertActiveSession, revokeSession };
