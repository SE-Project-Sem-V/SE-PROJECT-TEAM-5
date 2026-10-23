const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSetupError } = require("./config");
const { withTransaction } = require("./pool");

async function readMigrations(directory = path.join(__dirname, "migrations")) {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (!names.length || names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) ||
      new Set(names.map((name) => name.slice(0, 3))).size !== names.length) {
    throw new DatabaseSetupError("Migrations must have unique three-digit versions and names such as 001_initial_schema.sql.");
  }
  return Promise.all(names.map(async (name) => {
    // Checksums remain stable across Windows/Linux Git line-ending conversion.
    const sql = (await fs.readFile(path.join(directory, name), "utf8")).replace(/\r\n/g, "\n");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

async function migrate(pool, migrations) {
  const files = migrations || await readMigrations();
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext(current_schema() || ':chatapp-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows: applied } = await client.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
    // Applied migrations must be an unchanged prefix of the local migration list.
    if (applied.some((row, index) => files[index]?.name !== row.name || files[index]?.checksum !== row.checksum)) {
      throw new DatabaseSetupError("Applied migrations were changed, removed or reordered. Restore them and add a new migration instead.");
    }
    const pending = files.slice(applied.length);
    for (const file of pending) {
      await client.query(file.sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file.name, file.checksum]);
    }
    return pending.map((file) => file.name);
  });
}

module.exports = { migrate, readMigrations };
