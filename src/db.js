'use strict';

const { Pool } = require('pg');

function createPool(pgConfig) {
  return new Pool({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    max: pgConfig.maxConnections || 5,
    connectionTimeoutMillis: pgConfig.connectionTimeoutMillis || 5000,
    idleTimeoutMillis: 30000,
  });
}

module.exports = { createPool };
