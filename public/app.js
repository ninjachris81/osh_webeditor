/* global Vue */
'use strict';

const { createApp, markRaw } = Vue;

const ACTOR_COMMANDS = {
  1: 'ACTOR_ON', 2: 'ACTOR_OFF', 3: 'ACTOR_UP', 4: 'ACTOR_DOWN',
  5: 'ACTOR_START', 6: 'ACTOR_STOP', 7: 'ACTOR_PAUSE', 8: 'ACTOR_TOGGLE',
  9: 'ACTOR_SET_VALUE', 10: 'ACTOR_TRIGGER_SCRIPT', 20: 'ACTOR_NEXT',
  21: 'ACTOR_PREVIOUS', 40: 'ACTOR_SHUTTER_HALF_CLOSE',
  41: 'ACTOR_SHUTTER_HALF_OPEN', 42: 'ACTOR_SHUTTER_FULL_OPEN',
  43: 'ACTOR_SHUTTER_TURN_OPEN', 44: 'ACTOR_SHUTTER_TURN_CLOSE',
  46: 'ACTOR_SHUTTER_MANUAL_UP', 47: 'ACTOR_SHUTTER_MANUAL_DOWN',
};

const NUMERIC_TYPES = [
  'smallint', 'integer', 'bigint', 'numeric', 'decimal',
  'real', 'double precision', 'serial', 'bigserial',
];

async function api(path, options = {}) {
  const opts = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

createApp({
  data() {
    return {
      mainTables: [],
      otherTables: [],
      missingMain: [],
      currentTable: null,
      schema: null,
      rows: [],
      total: 0,
      limit: 50,
      offset: 0,
      orderBy: null,
      dir: 'asc',
      searchInput: '',
      search: '',
      filters: {},
      filterOptions: {},
      lookupOptions: {},
      loading: false,
      error: null,
      watch: { show: false, topic: '', status: 'connecting', statusText: 'Connecting', error: null, messages: [] },
      watchSource: null,
      editor: { show: false, mode: 'create', duplicate: false, fields: [], pk: {}, saving: false, error: null },
    };
  },

  created() {
    this.loadTables();
  },

  beforeUnmount() {
    this.closeWatch();
  },

  computed: {
    // Editor fields to show: base fields always; subtype fields only when the
    // actor's class_type matches (ShutterActor -> shutter fields, etc.).
    visibleEditorFields() {
      return this.editor.fields.filter((f) => this.isFieldVisible(f));
    },
  },

  methods: {
    isNumeric(t) {
      return NUMERIC_TYPES.includes(t);
    },

    editorClassType() {
      const f = this.editor.fields.find((x) => x.name === 'class_type');
      return f ? String(f.value).trim() : '';
    },

    isFieldVisible(field) {
      return !field.classType || field.classType === this.editorClassType();
    },

    isPkLocked(field) {
      // Primary key values are used to identify the row, so they are read-only
      // while editing - unless the column is explicitly marked editablePk
      // (e.g. value_group_id), in which case saving re-keys the row.
      return this.editor.mode === 'edit' && field.isPrimaryKey && !field.editablePk;
    },

    async loadTables() {
      try {
        const data = await api('/api/tables');
        this.mainTables = data.tables.filter((t) => t.main);
        this.otherTables = data.tables.filter((t) => !t.main);
        this.missingMain = data.missingMain || [];
        if (!this.currentTable && this.mainTables.length > 0) {
          this.selectTable(this.mainTables[0].name);
        }
      } catch (err) {
        this.error = `Failed to load table list: ${err.message}`;
      }
    },

    async selectTable(name) {
      this.currentTable = name;
      this.schema = null;
      this.rows = [];
      this.total = 0;
      this.offset = 0;
      this.search = '';
      this.searchInput = '';
      this.filters = {};
      this.filterOptions = {};
      this.lookupOptions = {};
      this.dir = 'asc';
      try {
        this.schema = await api(`/api/tables/${encodeURIComponent(name)}/schema`);
        this.orderBy = this.schema.primaryKey[0] || this.schema.columns[0].name;
        this.loadFilterOptions();
        await this.loadRows();
      } catch (err) {
        this.error = `Failed to load schema for ${name}: ${err.message}`;
      }
    },

    async loadFilterOptions() {
      if (!this.schema) return;
      for (const col of this.schema.columns) {
        if (col.quickfilter) {
          try {
            const data = await api(
              `/api/tables/${encodeURIComponent(this.currentTable)}/column-values/${encodeURIComponent(col.name)}`
            );
            this.filterOptions[col.name] = data.values;
          } catch (err) {
            // Non-fatal: the dropdown just stays empty.
          }
        }
        if (col.lookup) {
          try {
            const data = await api(
              `/api/tables/${encodeURIComponent(this.currentTable)}/lookup/${encodeURIComponent(col.name)}`
            );
            this.lookupOptions[col.name] = data.options;
          } catch (err) {
            // Non-fatal: the editor falls back to a plain text input.
          }
        }
      }
    },

    hasFilter(colName) {
      return Object.prototype.hasOwnProperty.call(this.filters, colName);
    },

    filterValue(colName) {
      return this.hasFilter(colName) ? this.filters[colName] : '';
    },

    setFilter(colName, rawValue) {
      const filters = { ...this.filters };
      if (rawValue === '' || rawValue === undefined) {
        delete filters[colName];
      } else {
        filters[colName] = rawValue;
      }
      this.filters = filters;
      this.offset = 0;
      this.loadRows();
    },

    async loadRows() {
      if (!this.currentTable) return;
      this.loading = true;
      try {
        const params = new URLSearchParams({ limit: this.limit, offset: this.offset });
        if (this.orderBy) {
          params.set('order', this.orderBy);
          params.set('dir', this.dir);
        }
        if (this.search) params.set('q', this.search);
        for (const [col, val] of Object.entries(this.filters)) {
          params.set(`f_${col}`, val);
        }
        const data = await api(`/api/tables/${encodeURIComponent(this.currentTable)}/rows?${params}`);
        this.rows = data.rows;
        this.total = data.total;
      } catch (err) {
        this.error = `Failed to load rows: ${err.message}`;
      } finally {
        this.loading = false;
      }
    },

    applySearch() {
      this.search = this.searchInput.trim();
      this.offset = 0;
      this.loadRows();
    },

    sortBy(col) {
      if (this.orderBy === col) {
        this.dir = this.dir === 'asc' ? 'desc' : 'asc';
      } else {
        this.orderBy = col;
        this.dir = 'asc';
      }
      this.offset = 0;
      this.loadRows();
    },

    prevPage() {
      this.offset = Math.max(0, this.offset - this.limit);
      this.loadRows();
    },

    nextPage() {
      this.offset += this.limit;
      this.loadRows();
    },

    changePageSize() {
      this.offset = 0;
      this.loadRows();
    },

    toInputValue(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    },

    buildFields(row) {
      return this.schema.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        isPrimaryKey: c.isPrimaryKey,
        editablePk: !!c.editablePk,
        lookup: c.lookup || null,
        // Joined columns come from subtype tables (e.g. dm_actors_shutter) and
        // are editable only when the actor's class_type matches the subtype.
        classType: c.classType || null,
        source: c.source || null,
        hasDefault: c.default !== null && c.default !== undefined,
        default: c.default,
        value: row ? this.toInputValue(row[c.name]) : '',
        isNull: row ? row[c.name] === null : false,
      }));
    },

    lookupOptionsFor(field) {
      return this.lookupOptions[field.name] || [];
    },

    // True when the current value is not part of the lookup options, so it is
    // shown explicitly instead of being silently hidden by the combobox.
    lookupValueMissing(field) {
      return (
        field.value !== '' &&
        !this.lookupOptionsFor(field).some((o) => String(o.value) === String(field.value))
      );
    },

    openCreate() {
      this.editor = {
        show: true,
        mode: 'create',
        duplicate: false,
        fields: this.buildFields(null),
        pk: {},
        saving: false,
        error: null,
      };
    },

    openEdit(row) {
      const pk = {};
      for (const k of this.schema.primaryKey) pk[k] = row[k];
      this.editor = {
        show: true,
        mode: 'edit',
        duplicate: false,
        fields: this.buildFields(row),
        pk,
        saving: false,
        error: null,
      };
    },

    openWatch(row) {
      this.closeWatch();
      const kind = this.currentTable === 'dm_actors' ? 'ac' : 'va';
      const topic = `osh/${kind}/${row.value_group_id}/${row.id}`;
      const params = new URLSearchParams({
        table: this.currentTable,
        value_group_id: row.value_group_id,
        id: row.id,
      });
      this.watch = {
        show: true,
        topic,
        status: 'connecting',
        statusText: 'Connecting',
        error: null,
        messages: [],
      };
      const source = markRaw(new EventSource(`/api/watch?${params}`));
      this.watchSource = source;
      source.addEventListener('status', (event) => {
        const status = JSON.parse(event.data);
        if (status.state === 'connected') {
          this.watch.status = 'connected';
          this.watch.statusText = 'Connected';
        } else if (status.state === 'connecting') {
          this.watch.status = 'connecting';
          this.watch.statusText = 'Reconnecting';
        }
      });
      source.addEventListener('message', (event) => {
        try {
          const { payload } = JSON.parse(event.data);
          const data = JSON.parse(payload);
          const timestamp = Number(data.t);
          const offsetSeconds = (Date.now() - timestamp) / 1000;
          const inSync = Number.isFinite(offsetSeconds) && Math.abs(offsetSeconds) < 2;
          const rawValue = this.currentTable === 'dm_actors'
            ? `${Object.prototype.hasOwnProperty.call(ACTOR_COMMANDS, data.c) ? ACTOR_COMMANDS[data.c] : 'Unknown command'} (${data.c})`
            : data.v;
          this.watch.messages.unshift({
            sender: data.s ?? '',
            value: rawValue === undefined ? '' : (typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue)),
            timestamp: Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Invalid timestamp',
            offset: inSync ? 'IN_SYNC' : Number.isFinite(offsetSeconds)
              ? `${offsetSeconds >= 0 ? '+' : ''}${offsetSeconds.toFixed(2)} s`
              : 'Invalid timestamp',
            inSync,
          });
          if (this.watch.messages.length > 500) this.watch.messages.pop();
        } catch (err) {
          this.watch.error = `Invalid MQTT JSON payload: ${err.message}`;
        }
      });
      source.addEventListener('error', (event) => {
        if (event.data) {
          const error = JSON.parse(event.data);
          this.watch.status = 'error';
          this.watch.statusText = 'Disconnected';
          this.watch.error = error.message;
          source.close();
          this.watchSource = null;
        } else if (this.watch.status !== 'error') {
          this.watch.status = 'connecting';
          this.watch.statusText = 'Reconnecting';
        }
      });
    },

    closeWatch() {
      if (this.watchSource) this.watchSource.close();
      this.watchSource = null;
      if (this.watch) this.watch.show = false;
    },

    openDuplicate(row) {
      const fields = this.buildFields(row);
      for (const field of fields) {
        if (field.isPrimaryKey && field.hasDefault) {
          field.value = '';
          field.isNull = false;
        }
      }
      this.editor = {
        show: true,
        mode: 'create',
        duplicate: true,
        fields,
        pk: {},
        saving: false,
        error: null,
      };
    },

    closeEditor() {
      this.editor.show = false;
    },

    collectValues() {
      const values = {};
      for (const f of this.editor.fields) {
        // Subtype fields are only submitted when the actor's class_type matches.
        if (f.classType && f.classType !== this.editorClassType()) continue;

        // While editing, PK columns are locked and excluded from the SET clause,
        // except editablePk columns which re-key the row when changed.
        if (this.editor.mode === 'edit' && f.isPrimaryKey && !f.editablePk) continue;

        // On create: leave untouched fields with a DB default out, so the default applies.
        if (this.editor.mode === 'create' && !f.isNull && f.hasDefault && f.value === '') continue;

        if (f.isNull) {
          values[f.name] = null;
        } else if (f.type === 'boolean') {
          values[f.name] = f.value === true || f.value === 'true';
        } else if (this.isNumeric(f.type)) {
          values[f.name] = f.value === '' ? null : f.value;
        } else {
          values[f.name] = f.value;
        }
      }
      return values;
    },

    async saveRow() {
      this.editor.saving = true;
      this.editor.error = null;
      try {
        if (this.editor.mode === 'create') {
          await api(`/api/tables/${encodeURIComponent(this.currentTable)}/rows`, {
            method: 'POST',
            body: { values: this.collectValues() },
          });
        } else {
          await api(`/api/tables/${encodeURIComponent(this.currentTable)}/rows`, {
            method: 'PUT',
            body: { pk: this.editor.pk, values: this.collectValues() },
          });
        }
        this.editor.show = false;
        await this.loadRows();
      } catch (err) {
        this.editor.error = err.message;
      } finally {
        this.editor.saving = false;
      }
    },

    async deleteRow(row) {
      const pk = {};
      for (const k of this.schema.primaryKey) pk[k] = row[k];
      const pkText = Object.entries(pk).map(([k, v]) => `${k}=${v}`).join(', ');
      const subtypeTables = [...new Set(this.schema.columns.filter((c) => c.source).map((c) => c.source))];
      const extra = subtypeTables.length
        ? `\nThis also deletes the matching rows from: ${subtypeTables.join(', ')}.`
        : '';
      if (!window.confirm(`Delete row (${pkText}) from ${this.currentTable}?${extra}`)) return;
      try {
        await api(`/api/tables/${encodeURIComponent(this.currentTable)}/rows`, {
          method: 'DELETE',
          body: { pk },
        });
        await this.loadRows();
      } catch (err) {
        this.error = `Failed to delete row: ${err.message}`;
      }
    },

    formatValue(v) {
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    },

    formatTitle(v) {
      if (v === null || v === undefined) return 'NULL';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    },
  },
}).mount('#app');
