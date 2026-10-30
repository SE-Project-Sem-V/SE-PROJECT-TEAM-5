async function insertSession(db, { id, userId, expiresAt }) {
  await db.query(
    "INSERT INTO user_sessions (id, user_id, expires_at) VALUES ($1::uuid, $2::uuid, $3)",
    [id, userId, expiresAt],
  );
}

async function findSession(db, id, userId, lock = false) {
  const { rows } = await db.query(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at
     FROM user_sessions AS s JOIN users AS u ON u.id = s.user_id
     WHERE s.id = $1::uuid AND s.user_id = $2::uuid${lock ? " FOR SHARE OF s" : ""}`,
    [id, userId],
  );
  return rows[0];
}

async function markRevoked(db, id, userId) {
  const { rowCount } = await db.query(
    `UPDATE user_sessions SET revoked_at = clock_timestamp()
     WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL`,
    [id, userId],
  );
  return rowCount;
}

module.exports = { insertSession, findSession, markRevoked };
