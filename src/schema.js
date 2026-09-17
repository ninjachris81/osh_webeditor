'use strict';

/**
 * Live database schema introspection (tables + columns + primary keys)
 * with a short in-memory cache.
 */
class SchemaCache {
  constructor(pool, schema = 'public', ttlMs = 60000) {
    this.pool = pool;
    this.schema = schema;
    this.ttlMs = ttlMs;
    this._tables = null;
    this._tablesAt = 0;
    this._columns = new Map();
  }

  async tables() {
    const now = Date.now();
    if (this._tables && now - this._tablesAt < this.ttlMs) {
      return this._tables;
    }
    const result = await this.pool.query(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [this.schema]
    );
    this._tables = result.rows;
    this._tablesAt = now;
    return this._tables;
  }

  async columns(table) {
    const cached = this._columns.get(table);
    const now = Date.now();
    if (cached && now - cached.at < this.ttlMs) {
      return cached.columns;
    }
    const result = await this.pool.query(
      `SELECT c.column_name AS name,
              c.data_type AS type,
              (c.is_nullable = 'YES') AS "nullable",
              c.column_default AS "default",
              EXISTS (
                SELECT 1
                  FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                   AND tc.table_schema  = kcu.table_schema
                   AND tc.table_name    = kcu.table_name
                 WHERE tc.constraint_type = 'PRIMARY KEY'
                   AND tc.table_schema = c.table_schema
                   AND tc.table_name   = c.table_name
                   AND kcu.column_name = c.column_name
              ) AS "isPrimaryKey"
         FROM information_schema.columns c
        WHERE c.table_schema = $1
          AND c.table_name   = $2
        ORDER BY c.ordinal_position`,
      [this.schema, table]
    );
    if (result.rows.length === 0) {
      const err = new Error(`Unknown table: ${table}`);
      err.status = 404;
      throw err;
    }
    this._columns.set(table, { columns: result.rows, at: now });
    return result.rows;
  }

  invalidate() {
    this._tables = null;
    this._columns.clear();
  }
}

module.exports = { SchemaCache };
