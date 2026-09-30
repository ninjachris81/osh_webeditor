'use strict';

const express = require('express');
const { spawn } = require('child_process');

// The main OSH datamodel tables, in the order they should appear in the UI.
const MAIN_TABLES = [
  'dm_actors',
  'dm_known_areas',
  'dm_known_devices',
  'dm_known_rooms',
  'dm_processor_tasks',
  'dm_processor_variables',
  'dm_users',
  'dm_value_groups',
  'dm_values',
  'dm_version',
];

// Columns that get a per-value quickfilter dropdown in the table header
// (any boolean column gets one too - see isQuickfilterColumn).
const QUICKFILTER_COLUMNS = new Set(['value_group_id', 'group_id', 'known_area_id', 'class_type']);

// Columns that are edited via a combobox of values looked up from another
// table. The stored value is <refColumn>, the dropdown label is <labelColumn>.
const LOOKUP_COLUMNS = {
  dm_known_rooms: {
    known_area_id: { refTable: 'dm_known_areas', refColumn: 'id', labelColumn: 'name' },
  },
  dm_actors: {
    value_group_id: { refTable: 'dm_value_groups', refColumn: 'id', labelColumn: 'id' },
  },
  dm_values: {
    value_group_id: { refTable: 'dm_value_groups', refColumn: 'id', labelColumn: 'id' },
  },
};

// Primary key columns that stay editable in edit mode (instead of being
// locked). Changing them re-keys the row; on combined views the key change is
// propagated to the subtype tables in the same transaction.
const EDITABLE_PK_COLUMNS = {
  dm_actors: ['value_group_id'],
  dm_values: ['value_group_id'],
};

// Sentinel used by the UI to filter for NULL values via quickfilters.
const NULL_FILTER = '__NULL__';

// Subtype tables that are merged into their base table instead of being shown
// separately. Base and subtype rows share the same composite key (joinKeys),
// and a subtype row is only joined in when the base row has the matching class_type.
const COMBINED_VIEWS = {
  dm_actors: {
    joinKeys: ['id', 'value_group_id'],
    joins: [
      { table: 'dm_actors_shutter', alias: 'acs', classType: 'ShutterActor' },
      { table: 'dm_actors_audio', alias: 'aca', classType: 'AudioPlaybackActor' },
    ],
  },
};

// Tables hidden from the table list because they are merged into a combined view.
const HIDDEN_TABLES = new Set(
  [].concat(...Object.values(COMBINED_VIEWS).map((v) => v.joins.map((j) => j.table)))
);

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const TEXT_TYPES = new Set([
  'text', 'character varying', 'character', 'varchar', 'char', 'uuid',
  'json', 'jsonb', 'inet', 'cidr', 'macaddr', 'name',
]);
const BOOL_TYPES = new Set(['boolean']);
const NUMERIC_TYPES = new Set([
  'smallint', 'integer', 'bigint', 'numeric', 'decimal',
  'real', 'double precision', 'serial', 'bigserial',
]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function quoteIdent(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Convert a JSON value coming from the UI into something pg can bind. */
function coerceValue(column, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value === '' && !TEXT_TYPES.has(column.type)) return null;

  if (BOOL_TYPES.has(column.type)) {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (['true', 't', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', 'f', '0', 'no', 'off'].includes(s)) return false;
    throw httpError(400, `Invalid boolean value for column "${column.name}": ${value}`);
  }

  if (NUMERIC_TYPES.has(column.type)) {
    const n = Number(value);
    if (Number.isNaN(n)) {
      throw httpError(400, `Invalid numeric value for column "${column.name}": ${value}`);
    }
    return n;
  }

  return value;
}

function createApiRouter({ pool, schemaCache, mqttConfig = {}, generalConfig = {} }) {
  const router = express.Router();

  function isQuickfilterColumn(name, type) {
    return QUICKFILTER_COLUMNS.has(name) || BOOL_TYPES.has(type);
  }

  function lookupFor(tableName, columnName) {
    const forTable = LOOKUP_COLUMNS[tableName];
    return forTable ? forTable[columnName] : undefined;
  }

  function isEditablePk(tableName, columnName) {
    const forTable = EDITABLE_PK_COLUMNS[tableName];
    return forTable ? forTable.includes(columnName) : false;
  }

  async function getTableMeta(tableName) {
    if (!IDENT_RE.test(tableName)) {
      throw httpError(400, `Invalid table name: ${tableName}`);
    }
    const tables = await schemaCache.tables();
    if (!tables.some((t) => t.name === tableName)) {
      throw httpError(404, `Unknown table: ${tableName}`);
    }
    const rawColumns = await schemaCache.columns(tableName);
    const primaryKey = rawColumns.filter((c) => c.isPrimaryKey).map((c) => c.name);

    // Base columns are qualified with the "base" alias so queries stay valid
    // once subtype tables are joined in.
    const columns = rawColumns.map((c) => ({
      ...c,
      quickfilter: isQuickfilterColumn(c.name, c.type),
      lookup: lookupFor(tableName, c.name),
      // Configured PK columns stay editable in edit mode (they re-key the row).
      editablePk: c.isPrimaryKey && isEditablePk(tableName, c.name),
      selectExpr: `base.${quoteIdent(c.name)}`,
      whereExpr: `base.${quoteIdent(c.name)}`,
    }));

    const meta = { table: tableName, columns, primaryKey, joinedColumns: [], joins: [] };

    const combined = COMBINED_VIEWS[tableName];
    if (combined) {
      const usedNames = new Set(columns.map((c) => c.name));
      for (const join of combined.joins) {
        let joinColumns;
        try {
          joinColumns = await schemaCache.columns(join.table);
        } catch (err) {
          continue; // subtype table does not exist - skip it
        }
        meta.joins.push({ ...join, joinKeys: combined.joinKeys });
        for (const jc of joinColumns) {
          if (combined.joinKeys.includes(jc.name)) continue;
          // Avoid output column name clashes (e.g. "comment" exists in dm_actors
          // and dm_actors_shutter): prefix with the subtype suffix if needed.
          let outName = jc.name;
          if (usedNames.has(outName)) {
            outName = `${join.table.slice(tableName.length + 1)}_${jc.name}`;
          }
          usedNames.add(outName);
          meta.joinedColumns.push({
            name: outName,
            sourceName: jc.name,
            type: jc.type,
            nullable: true,
            default: null,
            isPrimaryKey: false,
            quickfilter: isQuickfilterColumn(outName, jc.type),
            joined: true,
            source: join.table,
            classType: join.classType,
            selectExpr:
              `${join.alias}.${quoteIdent(jc.name)}` +
              (outName === jc.name ? '' : ` AS ${quoteIdent(outName)}`),
            whereExpr: `${join.alias}.${quoteIdent(jc.name)}`,
          });
        }
      }
    }

    return meta;
  }

  // FROM clause for reading: base table plus LEFT JOINs for combined views.
  function buildFromClause(meta) {
    let from = `${quoteIdent(meta.table)} base`;
    const hasClassType = meta.columns.some((c) => c.name === 'class_type');
    for (const join of meta.joins) {
      const conditions = join.joinKeys.map(
        (k) => `${join.alias}.${quoteIdent(k)} = base.${quoteIdent(k)}`
      );
      if (hasClassType && join.classType) {
        conditions.push(
          `base.${quoteIdent('class_type')} = '${String(join.classType).replace(/'/g, "''")}'`
        );
      }
      from += ` LEFT JOIN ${quoteIdent(join.table)} ${join.alias} ON ${conditions.join(' AND ')}`;
    }
    return from;
  }

  // Column shape exposed to the UI (internal SQL expressions stripped).
  function publicColumn(c) {
    const pub = { ...c };
    delete pub.selectExpr;
    delete pub.whereExpr;
    return pub;
  }

  // Extract values that belong to subtype tables of a combined view,
  // grouped by subtype table and keyed by the real column name there.
  function splitSubtypeValues(meta, values) {
    const result = {};
    if (!values) return result;
    for (const jc of meta.joinedColumns) {
      if (Object.prototype.hasOwnProperty.call(values, jc.name)) {
        const col = { name: jc.sourceName, type: jc.type };
        (result[jc.source] = result[jc.source] || {})[jc.sourceName] = coerceValue(col, values[jc.name]);
      }
    }
    return result;
  }

  function shiftPlaceholders(clause, offset) {
    return clause.replace(/\$(\d+)/g, (m, n) => `$${Number(n) + offset}`);
  }

  // Insert (or update) a row in a subtype table of a combined view.
  // keySource provides the join key values (a row object or a pk object).
  // With upsert=true an UPDATE is attempted first and an INSERT is only made
  // when no subtype row exists yet (ON CONFLICT is not usable here because it
  // pre-validates NOT NULL columns on the partial insert row).
  async function writeSubtypeRow(client, meta, join, keySource, subVals, classType, upsert) {
    if (join.classType && classType !== undefined && classType !== join.classType) {
      throw httpError(
        400,
        `Columns of ${join.table} can only be written when class_type is "${join.classType}" (got "${classType}").`
      );
    }
    const keyNames = [];
    const keyVals = [];
    for (const k of join.joinKeys) {
      const baseCol = meta.columns.find((c) => c.name === k);
      keyNames.push(k);
      keyVals.push(coerceValue(baseCol, keySource[k]));
    }
    const subNames = Object.keys(subVals);
    try {
      if (upsert) {
        const setClause = subNames.map((n, i) => `${quoteIdent(n)} = $${i + 1}`).join(', ');
        const whereClause = keyNames
          .map((k, i) => `${quoteIdent(k)} = $${subNames.length + i + 1}`)
          .join(' AND ');
        const updated = await client.query(
          `UPDATE ${quoteIdent(join.table)} SET ${setClause} WHERE ${whereClause}`,
          subNames.map((n) => subVals[n]).concat(keyVals)
        );
        if (updated.rowCount > 0) return;
      }
      const names = keyNames.concat(subNames);
      const allVals = keyVals.concat(subNames.map((n) => subVals[n]));
      const placeholders = names.map((_, i) => `$${i + 1}`);
      await client.query(
        `INSERT INTO ${quoteIdent(join.table)} (${names.map(quoteIdent).join(', ')}) ` +
          `VALUES (${placeholders.join(', ')})`,
        allVals
      );
    } catch (err) {
      if (err.code === '23505') {
        throw httpError(409, `Row already exists in ${join.table}: ${err.detail || err.message}`);
      }
      if (err.code === '23502') {
        throw httpError(400, `Missing required column in ${join.table}: ${err.message}`);
      }
      throw err;
    }
  }

  function buildPkWhere(primaryKey, columns, pk) {
    if (primaryKey.length === 0) {
      throw httpError(400, 'This table has no primary key - row updates/deletes are not supported.');
    }
    const clauses = [];
    const vals = [];
    for (const pkCol of primaryKey) {
      if (!pk || !Object.prototype.hasOwnProperty.call(pk, pkCol)) {
        throw httpError(400, `Missing primary key column in request: ${pkCol}`);
      }
      const column = columns.find((c) => c.name === pkCol);
      vals.push(coerceValue(column, pk[pkCol]));
      clauses.push(`${quoteIdent(pkCol)} = $${vals.length}`);
    }
    return { where: clauses.join(' AND '), vals };
  }

  router.get('/health', asyncHandler(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  router.get('/warning-log/events', asyncHandler(async (req, res) => {
    if (!mqttConfig.host) {
      throw httpError(503, 'MQTT is not configured. Set mqtt.host in config.json.');
    }

    const args = ['-h', String(mqttConfig.host), '-p', String(mqttConfig.port), '-t', 'osh/sw/#', '-q', '0', '-v', '-d'];
    if (mqttConfig.username) args.push('-u', String(mqttConfig.username));
    if (mqttConfig.password) args.push('-P', String(mqttConfig.password));

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('status', { state: 'connecting' });

    let closed = false;
    let hadError = false;
    const client = spawn('mosquitto_sub', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    client.stdout.setEncoding('utf8');
    client.stdout.on('data', (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      for (const line of lines) {
        const separator = line.indexOf(' ');
        if (separator < 0) continue;
        const topic = line.slice(0, separator);
        const topicParts = topic.split('/');
        if (topicParts.length !== 3 || topicParts[0] !== 'osh' || topicParts[1] !== 'sw' || !topicParts[2]) continue;
        try {
          const payload = JSON.parse(line.slice(separator + 1));
          send('warning', {
            deviceId: topicParts[2],
            sender: payload.s ?? '',
            message: payload.v === undefined
              ? ''
              : (typeof payload.v === 'object' ? JSON.stringify(payload.v) : String(payload.v)),
            receivedAt: Date.now(),
          });
        } catch (err) {
          send('warning-error', { topic, message: `Invalid warning JSON: ${err.message}` });
        }
      }
    });
    client.stderr.setEncoding('utf8');
    let diagnostics = '';
    client.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-512);
      if (/connection lost|sending CONNECT/i.test(chunk)) send('status', { state: 'connecting' });
      const connack = diagnostics.match(/received CONNACK \((\d+)\)/i);
      if (!connack) return;
      diagnostics = '';
      if (Number(connack[1]) === 0) {
        send('status', { state: 'connected' });
      } else {
        hadError = true;
        send('error', { message: `MQTT broker rejected the connection (CONNACK ${connack[1]}).` });
        client.kill('SIGTERM');
      }
    });
    client.on('error', (err) => {
      if (!closed) {
        hadError = true;
        send('error', { message: `Unable to start mosquitto_sub: ${err.message}` });
      }
    });
    client.on('close', (code) => {
      if (!closed && !hadError) {
        hadError = true;
        send('error', { message: `MQTT subscription stopped (exit code ${code}).` });
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 25000);
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      client.kill('SIGTERM');
    });
  }));

  router.get('/status-overview/events', asyncHandler(async (req, res) => {
    const tables = await schemaCache.tables();
    if (!tables.some((table) => table.name === 'dm_known_devices')) {
      throw httpError(404, 'Table not found: dm_known_devices');
    }
    const columns = await schemaCache.columns('dm_known_devices');
    if (!columns.some((column) => column.name === 'id')) {
      throw httpError(500, 'Required column missing from dm_known_devices: id');
    }
    const serviceColumn = columns.find((column) => column.name === 'service_id') ||
      columns.find((column) => column.name === 'serviceId');
    if (!serviceColumn) {
      throw httpError(500, 'Required column missing from dm_known_devices: service_id');
    }
    if (!mqttConfig.host) {
      throw httpError(503, 'MQTT is not configured. Set mqtt.host in config.json.');
    }

    const result = await pool.query(
      `SELECT * FROM ${quoteIdent('dm_known_devices')} ORDER BY ${quoteIdent('id')}`
    );
    const devices = result.rows.map((row) => ({
      ...row,
      id: String(row.id),
      serviceId: String(row[serviceColumn.name]),
    }));
    const parsedTimeout = Number(
      generalConfig.onlineTimeoutSeconds ?? mqttConfig.onlineTimeoutSeconds
    );
    const onlineTimeoutSeconds = Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : 60;
    const args = ['-h', String(mqttConfig.host), '-p', String(mqttConfig.port), '-t', 'osh/dd/+/+', '-q', '0', '-v', '-d'];
    if (mqttConfig.username) args.push('-u', String(mqttConfig.username));
    if (mqttConfig.password) args.push('-P', String(mqttConfig.password));

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('devices', { devices, onlineTimeoutSeconds });
    send('status', { state: 'connecting' });

    let closed = false;
    let hadError = false;
    const client = spawn('mosquitto_sub', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    client.stdout.setEncoding('utf8');
    client.stdout.on('data', (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      for (const line of lines) {
        const separator = line.indexOf(' ');
        if (separator < 0) continue;
        const topic = line.slice(0, separator);
        const topicParts = topic.split('/');
        if (topicParts.length !== 4 || topicParts[0] !== 'osh' || topicParts[1] !== 'dd') continue;
        const [deviceId, serviceId] = topicParts.slice(2);
        send('heartbeat', {
          deviceId,
          serviceId,
          payload: line.slice(separator + 1),
          receivedAt: Date.now(),
        });
      }
    });
    client.stderr.setEncoding('utf8');
    let diagnostics = '';
    client.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-512);
      if (/connection lost|sending CONNECT/i.test(chunk)) send('status', { state: 'connecting' });
      const connack = diagnostics.match(/received CONNACK \((\d+)\)/i);
      if (!connack) return;
      diagnostics = '';
      if (Number(connack[1]) === 0) {
        send('status', { state: 'connected' });
      } else {
        hadError = true;
        send('error', { message: `MQTT broker rejected the connection (CONNACK ${connack[1]}).` });
        client.kill('SIGTERM');
      }
    });
    client.on('error', (err) => {
      if (!closed) {
        hadError = true;
        send('error', { message: `Unable to start mosquitto_sub: ${err.message}` });
      }
    });
    client.on('close', (code) => {
      if (!closed && !hadError) {
        hadError = true;
        send('error', { message: `MQTT subscription stopped (exit code ${code}).` });
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 25000);
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      client.kill('SIGTERM');
    });
  }));

  router.get('/watch', asyncHandler(async (req, res) => {
    const topicParts = {
      dm_actors: ['ac', req.query.value_group_id, req.query.id],
      dm_values: ['va', req.query.value_group_id, req.query.id],
    }[req.query.table];
    if (!topicParts) {
      throw httpError(400, 'MQTT watch is only available for dm_actors and dm_values.');
    }
    const keyParts = topicParts.slice(1);
    if (keyParts.some((part) => typeof part !== 'string' || part === '' || /[\/# +\u0000]/.test(part))) {
      throw httpError(400, 'A valid value_group_id and id are required.');
    }
    if (!mqttConfig.host) {
      throw httpError(503, 'MQTT is not configured. Set mqtt.host in config.json.');
    }

    const topic = `osh/${topicParts[0]}/${keyParts.join('/')}`;
    const args = ['-h', String(mqttConfig.host), '-p', String(mqttConfig.port), '-t', topic, '-q', '0', '-F', '%t %r %p', '-d'];
    if (mqttConfig.username) args.push('-u', String(mqttConfig.username));
    if (mqttConfig.password) args.push('-P', String(mqttConfig.password));

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('status', { state: 'connecting', topic });

    let closed = false;
    let hadError = false;
    const client = spawn('mosquitto_sub', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    client.stdout.setEncoding('utf8');
    client.stdout.on('data', (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      for (const line of lines) {
        const firstSeparator = line.indexOf(' ');
        const secondSeparator = line.indexOf(' ', firstSeparator + 1);
        if (firstSeparator < 0 || secondSeparator < 0) continue;
        const messageTopic = line.slice(0, firstSeparator);
        if (messageTopic !== topic) continue;
        send('message', {
          retained: line.slice(firstSeparator + 1, secondSeparator) === '1',
          payload: line.slice(secondSeparator + 1),
          receivedAt: Date.now(),
        });
      }
    });

    client.stderr.setEncoding('utf8');
    let diagnostics = '';
    client.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-512);
      if (/connection lost|sending CONNECT/i.test(chunk)) {
        send('status', { state: 'connecting' });
      }
      const connack = diagnostics.match(/received CONNACK \((\d+)\)/i);
      if (!connack) return;
      diagnostics = '';
      if (Number(connack[1]) === 0) {
        send('status', { state: 'connected' });
      } else {
        hadError = true;
        send('error', { message: `MQTT broker rejected the connection (CONNACK ${connack[1]}).` });
        client.kill('SIGTERM');
      }
    });
    client.on('error', (err) => {
      if (!closed) {
        hadError = true;
        send('error', { message: `Unable to start mosquitto_sub: ${err.message}` });
      }
    });
    client.on('close', (code) => {
      if (!closed && !hadError) {
        hadError = true;
        send('error', { message: `MQTT subscription stopped (exit code ${code}).` });
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 25000);
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      client.kill('SIGTERM');
    });
  }));

  router.post('/watch/clear-retained', asyncHandler(async (req, res) => {
    const { table, value_group_id: valueGroupId, id } = req.body || {};
    const topicParts = {
      dm_actors: ['ac', valueGroupId, id],
      dm_values: ['va', valueGroupId, id],
    }[table];
    if (!topicParts) {
      throw httpError(400, 'MQTT retained messages can only be cleared for dm_actors and dm_values.');
    }
    const keyParts = topicParts.slice(1);
    if (keyParts.some((part) => (typeof part !== 'string' && typeof part !== 'number') || String(part) === '' || /[\/# +\u0000]/.test(String(part)))) {
      throw httpError(400, 'A valid value_group_id and id are required.');
    }
    if (!mqttConfig.host) {
      throw httpError(503, 'MQTT is not configured. Set mqtt.host in config.json.');
    }

    const topic = `osh/${topicParts[0]}/${keyParts.join('/')}`;
    const args = ['-h', String(mqttConfig.host), '-p', String(mqttConfig.port), '-t', topic, '-q', '0', '-r', '-n'];
    if (mqttConfig.username) args.push('-u', String(mqttConfig.username));
    if (mqttConfig.password) args.push('-P', String(mqttConfig.password));

    await new Promise((resolve, reject) => {
      const client = spawn('mosquitto_pub', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      client.stderr.setEncoding('utf8');
      client.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2048);
      });
      client.on('error', (err) => reject(httpError(503, `Unable to start mosquitto_pub: ${err.message}`)));
      client.on('close', (code) => {
        if (code === 0) resolve();
        else reject(httpError(502, `Failed to clear retained MQTT message${stderr ? `: ${stderr.trim()}` : ` (exit code ${code})`}`));
      });
    });

    res.json({ ok: true, topic });
  }));

  router.post('/watch/send-command', asyncHandler(async (req, res) => {
    const { table, value_group_id: valueGroupId, id, command } = req.body || {};
    if (table !== 'dm_actors') {
      throw httpError(400, 'Actor commands can only be sent to dm_actors topics.');
    }
    if ([valueGroupId, id].some((part) => (typeof part !== 'string' && typeof part !== 'number') || String(part) === '' || /[\/# +\u0000]/.test(String(part)))) {
      throw httpError(400, 'A valid value_group_id and id are required.');
    }
    const commandId = Number(command);
    const allowedCommands = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 40, 41, 42, 43, 44, 46, 47]);
    if (!Number.isInteger(commandId) || !allowedCommands.has(commandId)) {
      throw httpError(400, 'Unknown actor command.');
    }
    if (!mqttConfig.host) {
      throw httpError(503, 'MQTT is not configured. Set mqtt.host in config.json.');
    }

    const topic = `osh/ac/${valueGroupId}/${id}`;
    const payload = JSON.stringify({ c: commandId, s: 'osh-webeditor', t: Date.now() });
    const args = ['-h', String(mqttConfig.host), '-p', String(mqttConfig.port), '-t', topic, '-q', '0', '-m', payload];
    if (mqttConfig.username) args.push('-u', String(mqttConfig.username));
    if (mqttConfig.password) args.push('-P', String(mqttConfig.password));

    await new Promise((resolve, reject) => {
      const client = spawn('mosquitto_pub', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      client.stderr.setEncoding('utf8');
      client.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2048);
      });
      client.on('error', (err) => reject(httpError(503, `Unable to start mosquitto_pub: ${err.message}`)));
      client.on('close', (code) => {
        if (code === 0) resolve();
        else reject(httpError(502, `Failed to send actor command${stderr ? `: ${stderr.trim()}` : ` (exit code ${code})`}`));
      });
    });

    res.json({ ok: true, topic, command: commandId });
  }));

  router.get('/tables', asyncHandler(async (req, res) => {
    const tables = await schemaCache.tables();
    const names = new Set(tables.map((t) => t.name));

    const main = MAIN_TABLES.filter((n) => names.has(n)).map((name) => ({ name, main: true }));
    const missingMain = MAIN_TABLES.filter((n) => !names.has(n));
    // Tables merged into a combined view (e.g. dm_actors_shutter) are hidden.
    const others = [...names]
      .filter((n) => !MAIN_TABLES.includes(n) && !HIDDEN_TABLES.has(n))
      .sort()
      .map((name) => ({ name, main: false }));

    res.json({ tables: [...main, ...others], missingMain });
  }));

  router.get('/tables/:table/schema', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    res.json({
      table: meta.table,
      primaryKey: meta.primaryKey,
      columns: meta.columns.concat(meta.joinedColumns).map(publicColumn),
    });
  }));

  router.get('/tables/:table/rows', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    const allColumns = meta.columns.concat(meta.joinedColumns);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let orderCol = allColumns.find((c) => c.name === (meta.primaryKey[0] || allColumns[0].name));
    if (req.query.order) {
      const requested = allColumns.find((c) => c.name === req.query.order);
      if (requested) orderCol = requested;
    }
    const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const fromClause = buildFromClause(meta);
    const params = [];
    const whereParts = [];

    const q = String(req.query.q || '').trim();
    if (q) {
      params.push(`%${q}%`);
      whereParts.push('(' + allColumns.map((c) => `${c.whereExpr}::text ILIKE $1`).join(' OR ') + ')');
    }

    // Per-column quickfilters: f_<column>=<value> (exact match, NULL_FILTER for NULLs).
    for (const c of allColumns) {
      if (!c.quickfilter) continue;
      const raw = req.query[`f_${c.name}`];
      if (typeof raw !== 'string' || raw === '') continue;
      if (raw === NULL_FILTER) {
        whereParts.push(`${c.whereExpr} IS NULL`);
      } else {
        params.push(coerceValue(c, raw));
        whereParts.push(`${c.whereExpr} = $${params.length}`);
      }
    }

    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ${fromClause} ${where}`,
      params
    );

    const selectList = ['base.*'].concat(meta.joinedColumns.map((c) => c.selectExpr)).join(', ');

    params.push(limit, offset);
    const rowsResult = await pool.query(
      `SELECT ${selectList} FROM ${fromClause} ${where}
        ORDER BY ${orderCol.whereExpr} ${dir}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      rows: rowsResult.rows,
      total: countResult.rows[0].total,
      limit,
      offset,
      orderBy: orderCol.name,
      dir,
    });
  }));

  // Distinct values of a quickfilter column, used to populate the header dropdowns.
  router.get('/tables/:table/column-values/:column', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    const allColumns = meta.columns.concat(meta.joinedColumns);
    const column = allColumns.find((c) => c.name === req.params.column);
    if (!column) {
      throw httpError(404, `Unknown column: ${req.params.column}`);
    }
    if (!column.quickfilter) {
      throw httpError(400, `Column "${column.name}" does not support quickfilters.`);
    }
    const result = await pool.query(
      `SELECT DISTINCT ${column.whereExpr} AS v FROM ${buildFromClause(meta)} ORDER BY v LIMIT 500`
    );
    res.json({ values: result.rows.map((r) => r.v) });
  }));

  // Value/label pairs for a lookup column, used by the editor combobox.
  router.get('/tables/:table/lookup/:column', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    if (!meta.columns.some((c) => c.name === req.params.column)) {
      throw httpError(404, `Unknown column: ${req.params.column}`);
    }
    const lookup = lookupFor(meta.table, req.params.column);
    if (!lookup) {
      throw httpError(400, `Column "${req.params.column}" has no lookup.`);
    }
    const tables = await schemaCache.tables();
    if (!tables.some((t) => t.name === lookup.refTable)) {
      throw httpError(404, `Lookup table not found: ${lookup.refTable}`);
    }
    const result = await pool.query(
      `SELECT ${quoteIdent(lookup.refColumn)} AS value, ${quoteIdent(lookup.labelColumn)} AS label
         FROM ${quoteIdent(lookup.refTable)}
        ORDER BY ${quoteIdent(lookup.labelColumn)}
        LIMIT 1000`
    );
    res.json({ options: result.rows });
  }));

  router.post('/tables/:table/rows', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    const { table, columns } = meta;
    const values = (req.body && req.body.values) || {};

    const subtypeValues = splitSubtypeValues(meta, values);

    const cols = [];
    const vals = [];
    const placeholders = [];
    for (const column of columns) {
      if (Object.prototype.hasOwnProperty.call(values, column.name)) {
        cols.push(quoteIdent(column.name));
        vals.push(coerceValue(column, values[column.name]));
        placeholders.push(`$${vals.length}`);
      }
    }
    if (cols.length === 0) {
      throw httpError(400, 'No values provided.');
    }

    if (Object.keys(subtypeValues).length === 0) {
      const result = await pool.query(
        `INSERT INTO ${quoteIdent(table)} (${cols.join(', ')})
         VALUES (${placeholders.join(', ')}) RETURNING *`,
        vals
      );
      res.status(201).json({ row: result.rows[0] });
      return;
    }

    // Combined view: insert the base row and its subtype rows in one transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO ${quoteIdent(table)} (${cols.join(', ')})
         VALUES (${placeholders.join(', ')}) RETURNING *`,
        vals
      );
      const row = result.rows[0];
      for (const [joinTable, subVals] of Object.entries(subtypeValues)) {
        const join = meta.joins.find((j) => j.table === joinTable);
        await writeSubtypeRow(client, meta, join, row, subVals, row.class_type, false);
      }
      await client.query('COMMIT');
      res.status(201).json({ row });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  router.put('/tables/:table/rows', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    const { table, columns, primaryKey } = meta;
    const { pk, values } = req.body || {};

    const set = [];
    const vals = [];
    for (const column of columns) {
      if (primaryKey.includes(column.name) && !column.editablePk) continue; // PK columns are immutable here
      if (values && Object.prototype.hasOwnProperty.call(values, column.name)) {
        vals.push(coerceValue(column, values[column.name]));
        set.push(`${quoteIdent(column.name)} = $${vals.length}`);
      }
    }

    const subtypeValues = splitSubtypeValues(meta, values);
    const pkWhere = buildPkWhere(primaryKey, columns, pk);

    // New composite key after applying editablePk values (keySource for subtype writes).
    const newKey = {};
    for (const k of primaryKey) {
      const isSettable = meta.columns.find((c) => c.name === k && c.editablePk);
      newKey[k] = isSettable && values && Object.prototype.hasOwnProperty.call(values, k)
        ? values[k]
        : pk[k];
    }
    const keyChanged = primaryKey.some((k) => String(newKey[k]) !== String(pk[k]));

    if (meta.joins.length === 0) {
      if (set.length === 0) {
        throw httpError(400, 'No values provided.');
      }
      // Shift the $n placeholders of the PK clause behind the SET values.
      const pkClause = shiftPlaceholders(pkWhere.where, vals.length);
      const result = await pool.query(
        `UPDATE ${quoteIdent(table)} SET ${set.join(', ')} WHERE ${pkClause} RETURNING *`,
        vals.concat(pkWhere.vals)
      );
      if (result.rowCount === 0) {
        throw httpError(404, 'Row not found (it may have been deleted or the primary key changed).');
      }
      res.json({ row: result.rows[0] });
      return;
    }

    // Combined view: update base row + subtype rows in one transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let row;
      if (set.length > 0) {
        // Update the base row first. Subtype tables reference the base key with
        // ON UPDATE CASCADE, so a key change re-keys their rows automatically
        // (manual child-first re-keying would fail FK validation).
        const pkClause = shiftPlaceholders(pkWhere.where, vals.length);
        const result = await client.query(
          `UPDATE ${quoteIdent(table)} SET ${set.join(', ')} WHERE ${pkClause} RETURNING *`,
          vals.concat(pkWhere.vals)
        );
        if (result.rowCount === 0) {
          throw httpError(404, 'Row not found (it may have been deleted or the primary key changed).');
        }
        row = result.rows[0];
      } else {
        const result = await client.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${pkWhere.where}`,
          pkWhere.vals
        );
        if (result.rowCount === 0) {
          throw httpError(404, 'Row not found (it may have been deleted or the primary key changed).');
        }
        row = result.rows[0];
      }
      // Subtype values are only valid for the matching class_type and are
      // upserted against the (possibly re-keyed) composite key.
      for (const [joinTable, subVals] of Object.entries(subtypeValues)) {
        const join = meta.joins.find((j) => j.table === joinTable);
        await writeSubtypeRow(client, meta, join, newKey, subVals, row.class_type, true);
      }
      await client.query('COMMIT');
      res.json({ row });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        throw httpError(409, `A row with this key already exists: ${err.detail || err.message}`);
      }
      throw err;
    } finally {
      client.release();
    }
  }));

  router.delete('/tables/:table/rows', asyncHandler(async (req, res) => {
    const meta = await getTableMeta(req.params.table);
    const { table, columns, primaryKey } = meta;
    const { pk } = req.body || {};
    const pkWhere = buildPkWhere(primaryKey, columns, pk);

    if (meta.joins.length === 0) {
      const result = await pool.query(
        `DELETE FROM ${quoteIdent(table)} WHERE ${pkWhere.where}`,
        pkWhere.vals
      );
      if (result.rowCount === 0) {
        throw httpError(404, 'Row not found.');
      }
      res.json({ deleted: result.rowCount });
      return;
    }

    // Combined view: subtype rows hold FK references to the base row,
    // so delete them first in one transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let deleted = 0;
      for (const join of meta.joins) {
        const where = join.joinKeys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(' AND ');
        const keyVals = join.joinKeys.map((k) => {
          const baseCol = meta.columns.find((c) => c.name === k);
          return coerceValue(baseCol, pk[k]);
        });
        const r = await client.query(
          `DELETE FROM ${quoteIdent(join.table)} WHERE ${where}`,
          keyVals
        );
        deleted += r.rowCount;
      }
      const result = await client.query(
        `DELETE FROM ${quoteIdent(table)} WHERE ${pkWhere.where}`,
        pkWhere.vals
      );
      if (result.rowCount === 0) {
        throw httpError(404, 'Row not found.');
      }
      deleted += result.rowCount;
      await client.query('COMMIT');
      res.json({ deleted });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  router.post('/schema/refresh', asyncHandler(async (req, res) => {
    schemaCache.invalidate();
    res.json({ ok: true });
  }));

  // Error handler for this router.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(err);
    }
    res.status(status).json({ error: err.message || 'Internal server error' });
  });

  return router;
}

module.exports = { createApiRouter, MAIN_TABLES };
