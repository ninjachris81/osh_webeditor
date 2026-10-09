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

const VALUE_TYPES = {
  1: 'VALUE_TYPE_BRIGHTNESS',
  2: 'VALUE_TYPE_TEMP',
  3: 'VALUE_TYPE_HUMIDITY',
  4: 'VALUE_TYPE_MOTION',
  5: 'VALUE_TYPE_WATER_FLOW',
  6: 'VALUE_TYPE_WATER_LEVEL',
  7: 'VALUE_TYPE_TIMESTAMP',
  8: 'VALUE_TYPE_ENERGY_CONS',
  9: 'VALUE_TYPE_ENERGY_CONS_TIME',
  10: 'VALUE_TYPE_SWITCH',
  11: 'VALUE_TYPE_RELAY',
  30: 'VALUE_TYPE_SHUTTER_CLOSE_STATE',
  31: 'VALUE_TYPE_SHUTTER_TILT_STATE',
  32: 'VALUE_TYPE_SHUTTER_MODE',
  33: 'VALUE_TYPE_SHUTTER_TILT_MODE',
  34: 'VALUE_TYPE_SHUTTER_DOWN_TIME',
  35: 'VALUE_TYPE_SHUTTER_UP_TIME',
  40: 'VALUE_TYPE_MOTION_RADAR',
  41: 'VALUE_TYPE_MOTION_PIR',
  42: 'VALUE_TYPE_REED_CONTACT',
  50: 'VALUE_TYPE_RELAY_LIGHT',
  51: 'VALUE_TYPE_RELAY_SHUTTER',
  52: 'VALUE_TYPE_RELAY_TEMP_VALVE',
  53: 'VALUE_TYPE_RELAY_DOOR_OPEN',
  60: 'VALUE_TYPE_AUDIO',
  61: 'VALUE_TYPE_AUDIO_VOLUME',
  62: 'VALUE_TYPE_ALARM_SOUND',
  63: 'VALUE_TYPE_SOUND_URL',
  70: 'VALUE_TYPE_DOOR',
  80: 'VALUE_TYPE_HEAT_PUMP_DATA',
  90: 'VALUE_TYPE_VIRTUAL_ACTOR',
  91: 'VALUE_TYPE_TIMER',
  100: 'VALUE_TYPE_STATIC_TEMP',
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
      currentView: 'system-overview',
      systemOverview: { areas: [], loading: false, error: null, expandedAreas: {}, expandedRooms: {} },
      systemOverviewValueSource: null,
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
      statusOverview: { devices: [], loading: false, connection: 'connecting', connectionText: 'Connecting', error: null, onlineTimeoutSeconds: 60 },
      statusSource: null,
      statusTimer: null,
      statusNow: Date.now(),
      warningLog: { messages: [], connection: 'connecting', connectionText: 'Connecting', error: null },
      warningSource: null,
      editor: { show: false, mode: 'create', duplicate: false, fields: [], pk: {}, saving: false, error: null },
    };
  },

  created() {
    this.loadTables();
  },

  beforeUnmount() {
    this.closeWatch();
    this.closeStatusOverview();
    this.closeWarningLog();
    this.closeSystemOverviewValues();
  },

  computed: {
    // Editor fields to show: base fields always; subtype fields only when the
    // actor's class_type matches (ShutterActor -> shutter fields, etc.).
    visibleEditorFields() {
      return this.editor.fields.filter((f) => this.isFieldVisible(f));
    },
    valueTypeOptions() {
      return Object.entries(VALUE_TYPES).map(([value, label]) => ({ value, label }));
    },
    actorCommandOptions() {
      return Object.entries(ACTOR_COMMANDS).map(([value, label]) => ({ value, label }));
    },
    statusDeviceColumns() {
      const device = this.statusOverview.devices[0];
      return device
        ? Object.keys(device.details).filter((column) => (
          !(column === 'serviceId' && 'service_id' in device.details) &&
          column !== 'name' && column !== 'device_name'
        ))
        : ['id', 'service_id'];
    },
    onlineDeviceCount() {
      return this.statusOverview.devices.filter((device) => this.isDeviceOnline(device)).length;
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
        if (!this.currentTable) {
          this.showSystemOverview();
        }
      } catch (err) {
        this.error = `Failed to load table list: ${err.message}`;
      }
    },

    async selectTable(name) {
      this.closeSystemOverviewValues();
      this.closeStatusOverview();
      this.closeWarningLog();
      this.currentView = 'table';
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

    async showSystemOverview() {
      this.closeSystemOverviewValues();
      this.closeStatusOverview();
      this.closeWarningLog();
      this.closeWatch();
      this.currentView = 'system-overview';
      this.currentTable = null;
      this.systemOverview = {
        areas: [],
        loading: true,
        error: null,
        expandedAreas: {},
        expandedRooms: {},
      };
      try {
        const data = await api('/api/system-overview');
        this.systemOverview.areas = data.areas;
        this.systemOverview.expandedAreas = Object.fromEntries(
          data.areas.map((area) => [String(area.id), true])
        );
        const source = markRaw(new EventSource('/api/system-overview/values-events'));
        this.systemOverviewValueSource = source;
        source.addEventListener('value', (event) => {
          const update = JSON.parse(event.data);
          for (const area of this.systemOverview.areas) {
            for (const room of area.rooms) {
              for (const item of room.actors.concat(room.values)) {
                if (String(item.value_group_id) === String(update.value_group_id) && String(item.id) === String(update.id)) {
                  item.latestValue = update.value;
                  item.valueRevision = (item.valueRevision || 0) + 1;
                }
              }
            }
          }
        });
        source.addEventListener('error', (event) => {
          if (event.data) {
            const error = JSON.parse(event.data);
            this.systemOverview.error = `MQTT value stream failed: ${error.message}`;
            source.close();
            this.systemOverviewValueSource = null;
          }
        });
      } catch (err) {
        this.systemOverview.error = `Failed to load system hierarchy: ${err.message}`;
      } finally {
        this.systemOverview.loading = false;
      }
    },

    closeSystemOverviewValues() {
      if (this.systemOverviewValueSource) this.systemOverviewValueSource.close();
      this.systemOverviewValueSource = null;
    },

    toggleSystemArea(areaId) {
      const key = String(areaId);
      this.systemOverview.expandedAreas[key] = !this.systemOverview.expandedAreas[key];
    },

    toggleSystemRoom(areaId, roomId) {
      const key = `${areaId}:${roomId}`;
      this.systemOverview.expandedRooms[key] = !this.systemOverview.expandedRooms[key];
    },

    formatMindmapId(item) {
      const groupId = item.value_group_id;
      return groupId === null || groupId === undefined || groupId === ''
        ? String(item.id)
        : `${groupId}.${item.id}`;
    },

    async openMindmapItem(item, tableName) {
      await this.selectTable(tableName);
      if (!this.schema) return;
      const pk = {};
      for (const column of this.schema.primaryKey) {
        if (!Object.prototype.hasOwnProperty.call(item, column)) {
          this.error = `Cannot open ${tableName}: missing key column ${column}.`;
          return;
        }
        pk[column] = item[column];
      }
      try {
        const params = new URLSearchParams({ pk: JSON.stringify(pk) });
        const data = await api(`/api/tables/${encodeURIComponent(tableName)}/row?${params}`);
        this.openEdit(data.row);
      } catch (err) {
        this.error = `Failed to open ${tableName} row: ${err.message}`;
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

    valueTypeMissing(field) {
      return field.value !== '' && !this.valueTypeOptions.some((option) => option.value === field.value);
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

    openWatch(row, tableName = this.currentTable) {
      this.closeWatch();
      const kind = tableName === 'dm_actors' ? 'ac' : 'va';
      const topic = `osh/${kind}/${row.value_group_id}/${row.id}`;
      const params = new URLSearchParams({
        table: tableName,
        value_group_id: row.value_group_id,
        id: row.id,
      });
      this.watch = {
        show: true,
        topic,
        table: tableName,
        value_group_id: row.value_group_id,
        id: row.id,
        status: 'connecting',
        statusText: 'Connecting',
        error: null,
        notice: null,
        clearing: false,
        command: '1',
        sending: false,
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
          const { payload, retained, topic } = JSON.parse(event.data);
          if (payload === '') return;
          const data = JSON.parse(payload);
          const timestamp = Number(data.t);
          const offsetSeconds = (Date.now() - timestamp) / 1000;
          const inSync = Number.isFinite(offsetSeconds) && Math.abs(offsetSeconds) < 2;
          const command = data.c === undefined
            ? ''
            : `${Object.prototype.hasOwnProperty.call(ACTOR_COMMANDS, data.c) ? ACTOR_COMMANDS[data.c] : 'Unknown command'} (${data.c})`;
          const rawValue = data.v;
          this.watch.messages.unshift({
            sender: data.s ?? '',
            command,
            value: rawValue === undefined ? '' : (typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue)),
            timestamp: Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Invalid timestamp',
            offset: inSync ? 'IN_SYNC' : Number.isFinite(offsetSeconds)
              ? `${offsetSeconds >= 0 ? '+' : ''}${offsetSeconds.toFixed(2)} s`
              : 'Invalid timestamp',
            inSync,
            retained,
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

    async clearRetained() {
      this.watch.clearing = true;
      this.watch.error = null;
      this.watch.notice = null;
      try {
        await api('/api/watch/clear-retained', {
          method: 'POST',
          body: {
            table: this.watch.table,
            value_group_id: this.watch.value_group_id,
            id: this.watch.id,
          },
        });
        this.watch.notice = 'Retained message cleared.';
        this.watch.messages = this.watch.messages.map((message) => ({ ...message, retained: false }));
      } catch (err) {
        this.watch.error = err.message;
      } finally {
        this.watch.clearing = false;
      }
    },

    async sendActorCommand() {
      this.watch.sending = true;
      this.watch.error = null;
      this.watch.notice = null;
      try {
        await api('/api/watch/send-command', {
          method: 'POST',
          body: {
            table: this.watch.table,
            value_group_id: this.watch.value_group_id,
            id: this.watch.id,
            command: this.watch.command,
          },
        });
        const commandName = ACTOR_COMMANDS[this.watch.command];
        this.watch.notice = `${commandName} sent.`;
      } catch (err) {
        this.watch.error = err.message;
      } finally {
        this.watch.sending = false;
      }
    },

    showStatusOverview() {
      this.closeSystemOverviewValues();
      this.closeStatusOverview();
      this.closeWarningLog();
      this.closeWatch();
      this.currentView = 'overview';
      this.currentTable = null;
      this.statusOverview = {
        devices: [],
        loading: true,
        connection: 'connecting',
        connectionText: 'Connecting',
        error: null,
        onlineTimeoutSeconds: 60,
      };
      this.statusNow = Date.now();
      this.statusTimer = setInterval(() => {
        this.statusNow = Date.now();
      }, 1000);

      const source = markRaw(new EventSource('/api/status-overview/events'));
      this.statusSource = source;
      source.addEventListener('devices', (event) => {
        const data = JSON.parse(event.data);
        this.statusOverview.devices = data.devices.map((details) => ({
          id: String(details.id),
          serviceId: String(details.serviceId),
          details,
          displayName: details.name || details.device_name || details.serviceId,
          unknown: false,
          lastMessageAt: null,
          health: null,
          uptime: null,
        }));
        this.statusOverview.onlineTimeoutSeconds = data.onlineTimeoutSeconds;
        this.statusOverview.loading = false;
      });
      source.addEventListener('status', (event) => {
        const data = JSON.parse(event.data);
        this.statusOverview.connection = data.state === 'connected' ? 'connected' : 'connecting';
        this.statusOverview.connectionText = data.state === 'connected' ? 'MQTT connected' : 'Connecting to MQTT';
      });
      source.addEventListener('heartbeat', (event) => {
        try {
          const data = JSON.parse(event.data);
          const message = JSON.parse(data.payload);
          const index = this.statusOverview.devices.findIndex((device) => (
            device.id === data.deviceId && device.serviceId === data.serviceId
          ));
          const messageTimestamp = this.timestampMilliseconds(message.t);
          const device = index < 0
            ? {
              id: String(data.deviceId),
              serviceId: String(data.serviceId),
              details: { id: String(data.deviceId), service_id: String(data.serviceId) },
              displayName: 'Unknown Service',
              unknown: true,
            }
            : this.statusOverview.devices[index];
          const updatedDevice = {
            ...device,
            lastMessageAt: data.receivedAt,
            health: Number(message.h) === 1,
            uptime: this.formatUptime(message.v),
            messageTimestamp,
            senderId: message.s,
            rawHeartbeat: message,
          };
          if (index < 0) this.statusOverview.devices.push(updatedDevice);
          else this.statusOverview.devices.splice(index, 1, updatedDevice);
        } catch (err) {
          this.statusOverview.error = `Invalid device heartbeat: ${err.message}`;
        }
      });
      source.addEventListener('error', (event) => {
        if (event.data) {
          const data = JSON.parse(event.data);
          this.statusOverview.connection = 'error';
          this.statusOverview.connectionText = 'MQTT disconnected';
          this.statusOverview.error = data.message;
          this.statusOverview.loading = false;
          source.close();
          this.statusSource = null;
        } else if (this.statusOverview.connection !== 'error') {
          this.statusOverview.connection = 'connecting';
          this.statusOverview.connectionText = 'Reconnecting to MQTT';
        }
      });
    },

    closeStatusOverview() {
      if (this.statusSource) this.statusSource.close();
      this.statusSource = null;
      if (this.statusTimer) clearInterval(this.statusTimer);
      this.statusTimer = null;
    },

    showWarningLog() {
      this.closeSystemOverviewValues();
      this.closeWarningLog();
      this.closeStatusOverview();
      this.closeWatch();
      this.currentView = 'warning-log';
      this.currentTable = null;
      this.warningLog = {
        messages: [],
        connection: 'connecting',
        connectionText: 'Connecting',
        error: null,
      };
      const source = markRaw(new EventSource('/api/warning-log/events'));
      this.warningSource = source;
      source.addEventListener('status', (event) => {
        const data = JSON.parse(event.data);
        this.warningLog.connection = data.state === 'connected' ? 'connected' : 'connecting';
        this.warningLog.connectionText = data.state === 'connected' ? 'MQTT connected' : 'Connecting to MQTT';
      });
      source.addEventListener('warning', (event) => {
        const warning = JSON.parse(event.data);
        this.warningLog.messages.unshift(warning);
        if (this.warningLog.messages.length > 1000) this.warningLog.messages.pop();
      });
      source.addEventListener('warning-error', (event) => {
        const data = JSON.parse(event.data);
        this.warningLog.error = `${data.topic}: ${data.message}`;
      });
      source.addEventListener('error', (event) => {
        if (event.data) {
          const data = JSON.parse(event.data);
          this.warningLog.connection = 'error';
          this.warningLog.connectionText = 'MQTT disconnected';
          this.warningLog.error = data.message;
          source.close();
          this.warningSource = null;
        } else if (this.warningLog.connection !== 'error') {
          this.warningLog.connection = 'connecting';
          this.warningLog.connectionText = 'Reconnecting to MQTT';
        }
      });
    },

    closeWarningLog() {
      if (this.warningSource) this.warningSource.close();
      this.warningSource = null;
    },

    async openRegisterDevice(device) {
      try {
        const tableName = 'dm_known_devices';
        const schema = await api(`/api/tables/${encodeURIComponent(tableName)}/schema`);
        this.currentTable = tableName;
        this.schema = schema;
        this.filterOptions = {};
        this.lookupOptions = {};
        const fields = this.buildFields(null);
        const rawValues = {
          id: device.id,
          service_id: device.serviceId,
          serviceId: device.serviceId,
          name: 'Unknown Service',
          device_name: 'Unknown Service',
          sender_id: device.rawHeartbeat.s,
          senderId: device.rawHeartbeat.s,
          sender: device.rawHeartbeat.s,
          s: device.rawHeartbeat.s,
          health: device.rawHeartbeat.h,
          h: device.rawHeartbeat.h,
          timestamp: device.rawHeartbeat.t,
          t: device.rawHeartbeat.t,
          uptime: device.rawHeartbeat.v,
          v: device.rawHeartbeat.v,
        };
        for (const field of fields) {
          if (!Object.prototype.hasOwnProperty.call(rawValues, field.name)) continue;
          const value = rawValues[field.name];
          field.value = field.type === 'boolean'
            ? Number(value) === 1
            : this.toInputValue(value);
          field.isNull = value === null || value === undefined;
        }
        this.editor = {
          show: true,
          mode: 'create',
          duplicate: false,
          returnToOverview: true,
          fields,
          pk: {},
          saving: false,
          error: null,
        };
      } catch (err) {
        this.statusOverview.error = `Failed to prepare device registration: ${err.message}`;
      }
    },

    async openKnownDevice(device) {
      await this.selectTable('dm_known_devices');
      if (!this.schema) return;
      this.openEdit(device.details);
    },

    isDeviceOnline(device) {
      if (device.lastMessageAt === null || !Number.isFinite(device.messageTimestamp)) return false;
      const timeout = this.statusOverview.onlineTimeoutSeconds * 1000;
      return this.statusNow - device.lastMessageAt <= timeout &&
        Math.abs(this.statusNow - device.messageTimestamp) <= timeout;
    },

    timestampMilliseconds(timestamp) {
      const value = Number(timestamp);
      if (!Number.isFinite(value) || value <= 0) return NaN;
      return value < 1e12 ? value * 1000 : value;
    },

    formatUptime(milliseconds) {
      const totalSeconds = Math.floor(Number(milliseconds) / 1000);
      if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'Unknown';
      const units = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1],
      ];
      let remaining = totalSeconds;
      const parts = [];
      for (const [unit, seconds] of units) {
        const count = Math.floor(remaining / seconds);
        if (count > 0) {
          parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
          remaining %= seconds;
        }
        if (parts.length === 2) break;
      }
      return parts.length ? parts.join(' ') : '0 seconds';
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
        if (this.editor.returnToOverview) {
          this.showStatusOverview();
        } else {
          await this.loadRows();
        }
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

    formatCellValue(tableName, columnName, value) {
      if (columnName === 'value_type' && ['dm_actors', 'dm_values'].includes(tableName)) {
        const label = VALUE_TYPES[Number(value)];
        if (label) return `${label} (${value})`;
      }
      return this.formatValue(value);
    },

    formatTitle(v) {
      if (v === null || v === undefined) return 'NULL';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    },
  },
}).mount('#app');
