const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { insertSession } = require("../../db/sessions");

// Test data only: production verification always executes against its supplied DB.
function memorySessions() {
  const rows = new Map();
  function query(sql, values = []) {
    if (sql.includes("INSERT INTO user_sessions")) {
      rows.set(values[0], { id: values[0], user_id: values[1], expires_at: values[2], revoked_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM user_sessions")) {
      const row = rows.get(values[0]);
      return { rows: row && (!values[1] || row.user_id.toLowerCase() === values[1].toLowerCase()) ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE user_sessions")) {
      const row = rows.get(values[0]);
      if (!row || row.revoked_at) return { rowCount: 0, rows: [] };
      row.revoked_at = new Date();
      return { rowCount: 1, rows: [] };
    }
    return null;
  }
  function token(userId, key, options = {}) {
    const id = randomUUID();
    query("INSERT INTO user_sessions", [id, userId, new Date(Date.now() + 7200000)]);
    return jwt.sign({ sub: userId, jti: id }, key, { expiresIn: "2m", ...options });
  }
  return { query, token, rows };
}

async function prepareTokens(db, userIds, key) {
  const ids = new Map();
  for (const userId of userIds) {
    const id = randomUUID();
    await insertSession(db, { id, userId, expiresAt: new Date(Date.now() + 7200000) });
    ids.set(userId.toLowerCase(), id);
  }
  return (userId, options = {}) => jwt.sign({ sub: userId, jti: ids.get(userId.toLowerCase()) }, key,
    { expiresIn: "2m", ...options });
}

module.exports = { memorySessions, prepareTokens };
