'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  postgres: {
    host: 'localhost',
    port: 5432,
    database: 'osh_db',
    user: 'postgres',
    password: '',
    schema: 'public',
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
  },
};

function loadConfig() {
  const configPath = process.env.OSH_WEBAPP_CONFIG || path.join(__dirname, '..', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`ERROR: configuration file not found: ${configPath}`);
    console.error('Copy config.example.json to config.json and set your PostgreSQL connection parameters.');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`ERROR: cannot parse configuration file ${configPath}: ${err.message}`);
    process.exit(1);
  }

  const config = {
    postgres: { ...DEFAULTS.postgres, ...(parsed.postgres || {}) },
    server: { ...DEFAULTS.server, ...(parsed.server || {}) },
  };

  if (!config.postgres.database) {
    console.error('ERROR: "postgres.database" is required in the configuration file.');
    process.exit(1);
  }

  return { config, configPath };
}

module.exports = { loadConfig };
