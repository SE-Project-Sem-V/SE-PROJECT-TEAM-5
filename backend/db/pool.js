const { Pool } = require("pg");
const { databaseConfig, databaseFailureCode } = require("./config");
const { logFailure } = require("../logging");

function createPool(env = process.env, logger = console) {
  const pool = new Pool(databaseConfig(env));
  pool.on("error", (error) => {
    logFailure(logger, "database.idle.failed", databaseFailureCode(error));
  });
  return pool;
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    // A connection whose rollback failed must not return to the usable pool.
    client.release(releaseError);
  }
}

module.exports = { createPool, withTransaction };
