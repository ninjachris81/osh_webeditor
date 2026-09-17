'use strict';

const path = require('path');
const express = require('express');

const { loadConfig } = require('./src/config');
const { createPool } = require('./src/db');
const { SchemaCache } = require('./src/schema');
const { createApiRouter } = require('./src/api');

const { config, configPath } = loadConfig();

const pool = createPool(config.postgres);
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err.message);
});

const schemaCache = new SchemaCache(pool, config.postgres.schema);

const app = express();
app.use(express.json({ limit: '2mb' }));

// Locally vendored Vue.js (no CDN required -> works offline on the Raspberry Pi).
app.get('/vendor/vue.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.sendFile(require.resolve('vue/dist/vue.global.prod.js'));
});

app.use('/api', createApiRouter({ pool, schemaCache }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(`OSH webapp listening on http://${config.server.host}:${config.server.port}`);
  console.log(`Configuration file: ${configPath}`);
  console.log(
    `PostgreSQL: ${config.postgres.user}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database} (schema ${config.postgres.schema})`
  );
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down...');
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
