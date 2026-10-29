const fs = require("node:fs");
const path = require("node:path");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

class DatabaseSetupError extends Error {}

const SETUP_MESSAGES = new Set([
  "Use the documented PG* fields and DB_SSL_MODE; URL, service, SSL and session-option overrides are unsupported.",
  "DB_SSL_MODE must be disable or verify-full.",
  "TLS may be disabled only for loopback development/test connections.",
  "DB_SSL_CA_FILE requires DB_SSL_MODE=verify-full.",
  "Cannot read DB_SSL_CA_FILE. Check the configured CA certificate.",
  "Tests require a separate loopback TEST_PGDATABASE ending in _test, outside production.",
  "Migrations must have unique three-digit versions and names such as 001_initial_schema.sql.",
  "Applied migrations were changed, removed or reordered. Restore them and add a new migration instead.",
  "Seed fixture conflicts with existing data. Nothing was overwritten; use a separate development database.",
  "Seeding requires DB_ALLOW_SEED=true, development/test mode, and a loopback database ending in _dev or _test.",
  "Seed target does not match the configured development/test database.",
  "Use npm run db:migrate, npm run db:seed or npm run db:check.",
  "Schema migration state differs from this checkout. Run db:migrate or restore applied migrations.",
]);

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new DatabaseSetupError(`${name} must be set in backend/.env or the process environment.`);
  }
  return value;
}

function integer(env, name, fallback, max) {
  const value = env[name] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new DatabaseSetupError(`${name} must be an integer between 1 and ${max}.`);
  }
  return Number(value);
}

function isLocalHost(host) {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

function databaseConfig(env = process.env) {
  // Use explicit PG* fields, rather than URL options that can override TLS policy.
  if (env.DATABASE_URL || env.PGSSLMODE || env.PGOPTIONS || env.PGSERVICE) {
    throw new DatabaseSetupError("Use the documented PG* fields and DB_SSL_MODE; URL, service, SSL and session-option overrides are unsupported.");
  }
  const host = required(env, "PGHOST").trim();
  const localDevelopment = isLocalHost(host) && ["development", "test"].includes(env.NODE_ENV);
  const sslMode = env.DB_SSL_MODE || "verify-full";
  if (!["disable", "verify-full"].includes(sslMode)) {
    throw new DatabaseSetupError("DB_SSL_MODE must be disable or verify-full.");
  }
  if (sslMode === "disable" && !localDevelopment) {
    throw new DatabaseSetupError("TLS may be disabled only for loopback development/test connections.");
  }
  if (sslMode === "disable" && env.DB_SSL_CA_FILE) {
    throw new DatabaseSetupError("DB_SSL_CA_FILE requires DB_SSL_MODE=verify-full.");
  }

  let ssl = false;
  if (sslMode === "verify-full") {
    ssl = { rejectUnauthorized: true };
    if (env.DB_SSL_CA_FILE) {
      try {
        ssl.ca = fs.readFileSync(path.resolve(__dirname, "..", env.DB_SSL_CA_FILE), "utf8");
      } catch {
        throw new DatabaseSetupError("Cannot read DB_SSL_CA_FILE. Check the configured CA certificate.");
      }
    }
  }

  return {
    host,
    port: integer(env, "PGPORT", 5432, 65535),
    database: required(env, "PGDATABASE").trim(),
    user: required(env, "PGUSER").trim(),
    password: required(env, "PGPASSWORD"),
    ssl,
    max: integer(env, "DB_POOL_MAX", 10, 50),
    connectionTimeoutMillis: integer(env, "DB_CONNECTION_TIMEOUT_MS", 5000, 60000),
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    lock_timeout: 10000,
    application_name: "chatapp-backend",
    options: "-c search_path=public",
  };
}

function testDatabaseEnvironment(env) {
  const database = required(env, "TEST_PGDATABASE").trim();
  if (env.NODE_ENV === "production" || !isLocalHost(required(env, "PGHOST").trim()) ||
      !/^[a-z][a-z0-9_]*_test$/.test(database) || database === env.PGDATABASE?.trim()) {
    throw new DatabaseSetupError("Tests require a separate loopback TEST_PGDATABASE ending in _test, outside production.");
  }
  return { ...env, NODE_ENV: "test", PGDATABASE: database };
}

function formatDatabaseError(error) {
  try {
    if (error instanceof DatabaseSetupError && SETUP_MESSAGES.has(error.message)) return error.message;
    if (error instanceof DatabaseSetupError &&
        /^(PGHOST|PGDATABASE|PGUSER|PGPASSWORD|TEST_PGDATABASE) must be set in backend\/\.env or the process environment\.$/.test(error.message)) return error.message;
    if (error instanceof DatabaseSetupError &&
        /^(PGPORT|DB_POOL_MAX|DB_CONNECTION_TIMEOUT_MS) must be an integer between 1 and (65535|50|60000)\.$/.test(error.message)) return error.message;
  } catch {
    // An untrusted exception can have a throwing message getter.
  }
  // Never print a pg error's message/detail/SQL: they can contain credentials,
  // usernames, hashes, or message content. Only expose known error codes.
  const hints = {
    ECONNREFUSED: "PostgreSQL is not accepting connections. Start the database and check PGHOST/PGPORT.",
    ENOTFOUND: "The database host could not be resolved. Check PGHOST.",
    "28P01": "Database authentication failed. Check the private PGUSER/PGPASSWORD configuration.",
    "3D000": "The configured database does not exist. Create it before running this command.",
    "42501": "The database role lacks permission for this operation.",
    "23505": "A unique-key conflict occurred. Existing records were preserved.",
    "23503": "A referenced database record is missing or still in use.",
    "23001": "A referenced database record is still in use; deletion was restricted.",
    "23514": "A database integrity check rejected the operation.",
    "42P01": "Required tables are missing. Run npm run db:migrate first.",
    "55P03": "A database lock timed out. Wait for the other operation to finish and retry.",
  };
  try {
    const code = error?.code;
    if (typeof code === "string" && Object.hasOwn(hints, code)) return hints[code];
  } catch {
    // An untrusted exception can have a throwing code getter.
  }
  return "Database operation failed. Check connectivity, TLS, permissions and schema configuration; no sensitive error details were logged.";
}

function databaseFailureCode(error) {
  try {
    if (error instanceof DatabaseSetupError) return "DB_CONFIGURATION_FAILED";
    const code = error?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") return "DB_CONNECTION_FAILED";
    if (code === "28P01") return "DB_AUTH_FAILED";
  } catch {
    // No exception property is required for the generic classification.
  }
  return "DB_OPERATION_FAILED";
}

module.exports = { DatabaseSetupError, databaseConfig, formatDatabaseError, databaseFailureCode, isLocalHost, testDatabaseEnvironment };
