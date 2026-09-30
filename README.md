# OSH Database Webapp

A small web application (Node.js + Express backend, Vue.js 3 frontend) to **list and edit
the contents of the OSH PostgreSQL database tables**. No login/authentication — intended for
use on a trusted local network.

The app is **schema-driven**: it introspects the live database via `information_schema`, so it
works with the real table definitions and automatically picks up new columns or tables.

## Main tables

These tables are shown prominently in the UI (all other tables are listed too):

| Table                   | Purpose                              |
| ----------------------- | ------------------------------------ |
| `dm_actors`             | Actor definitions (per value group)  |
| `dm_known_areas`        | Known areas                          |
| `dm_known_devices`      | Known devices                        |
| `dm_known_rooms`        | Known rooms (assigned to areas)      |
| `dm_processor_tasks`    | Processor tasks (scripts/schedules)  |
| `dm_processor_variables`| Processor variables                  |
| `dm_users`              | Users and their rights               |
| `dm_values`             | Value definitions (per value group)  |

## Combined `dm_actors` view

`dm_actors_shutter` and `dm_actors_audio` are not listed separately — their columns are
merged into the `dm_actors` view instead. Rows are matched on the shared composite key
(`id`, `value_group_id`), and subtype data is only joined in when the actor's `class_type`
matches (`ShutterActor` → `dm_actors_shutter`, `AudioPlaybackActor` → `dm_actors_audio`).
The clashing `comment` column of `dm_actors_shutter` is shown as `shutter_comment`.

In the row editor, subtype fields appear once the matching `class_type` is set and are
editable — writes go to the subtype tables (updated, or inserted when the actor has no
subtype row yet) in one transaction with the base-row change. Subtype fields that don't
match the actor's `class_type` are hidden and rejected by the API. Deleting an actor also
deletes its subtype rows (they hold foreign keys to the base row).

## Features

- Browse all tables: pagination, sorting, full-text-ish search across all columns
- Quickfilters in the table header for `value_group_id`, `group_id`, `known_area_id`,
  `class_type` and every boolean column (dropdown of distinct values, incl. NULL)
- Lookup comboboxes in the row editor for foreign-key columns
  (e.g. `dm_known_rooms.known_area_id` lists all `dm_known_areas.name` and stores the id)
- `value_group_id` (part of the composite primary key in `dm_actors` / `dm_values`) is
  editable via its combobox even in edit mode — changing it re-keys the row, and the
  key change cascades to the actor subtype tables (`ON UPDATE CASCADE`) in one transaction
- Create / edit / delete rows (edit/delete require a primary key on the table)
- Type-aware editor: boolean dropdowns, numeric inputs, NULL checkboxes,
  database default values honoured on insert
- Vue.js is vendored locally (no CDN) — works offline on the Pi
- No build step required

## Configuration

Copy the example config and adjust it:

```bash
cp config.example.json config.json
```

```json
{
  "postgres": {
    "host": "localhost",
    "port": 5432,
    "database": "osh_db",
    "user": "postgres",
    "password": "changeme",
    "schema": "public"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "general": {
    "onlineTimeoutSeconds": 60
  },
  "mqtt": {
    "host": "localhost",
    "port": 1883,
    "username": "",
    "password": ""
  }
}
```

The optional `mqtt` section configures the broker used by the **Watch** action for
`dm_actors` and `dm_values`. The app subscribes to `osh/ac/<value_group_id>/<id>` for
actors and `osh/va/<value_group_id>/<id>` for values. The installer includes
`mosquitto-clients`, which provides the `mosquitto_sub` client used by the server.

The **Status Overview** subscribes to `osh/dd/+/+` for device heartbeats.
`general.onlineTimeoutSeconds` controls how long a device remains online without a
message (default `60`). It displays all rows from `dm_known_devices`, along with each
device's heartbeat health, sender, message timestamp, and human-readable service uptime.

The config file path can be overridden with the `OSH_WEBAPP_CONFIG` environment variable.

## Run locally (development)

```bash
npm install
cp config.example.json config.json   # edit connection parameters
npm start
# open http://localhost:8080/
```

## Install on a Raspberry Pi (systemd service)

From this directory on the Pi:

```bash
sudo ./install/install.sh
```

The script will:

1. Install required apt packages (`ca-certificates`, `curl`, `gnupg`, `git`, `build-essential`)
2. Install Node.js if missing or too old — first from the distribution packages, and if
   that yields a version < 16, automatically from the NodeSource repository (Node 20 by
   default, override with `OSH_WEBAPP_NODE`)
3. Copy the app to `/opt/osh-webapp` and install the `node_modules`
   (copied from this directory if present, otherwise installed via npm/corepack)
4. Create `/opt/osh-webapp/config.json` from the example if it does not exist
   (edit it, then `sudo systemctl restart osh-webapp`)
5. Install and start `osh-webapp.service` (enabled at boot, auto-restart on failure)

Useful commands afterwards:

```bash
sudo systemctl status osh-webapp      # service status
journalctl -u osh-webapp -f           # follow logs
sudo systemctl restart osh-webapp     # apply config changes
sudo ./install/uninstall.sh           # remove everything
```

Environment overrides for the installer:

- `OSH_WEBAPP_DIR` — installation directory (default `/opt/osh-webapp`)
- `OSH_WEBAPP_USER` — user the service runs as (default: the user calling `sudo`, or `osh`)
- `OSH_WEBAPP_NODE` — Node.js major version installed from NodeSource when the
  distribution package is too old (default `20`)

> **Offline install tip:** run `npm install` in this directory first, then copy the whole
> directory to the Pi — the installer will reuse the included `node_modules` and skip the
> network install. Only the apt packages still require network access.

> **Note:** the database user in `config.json` needs `SELECT` on all tables plus
> `INSERT`/`UPDATE`/`DELETE` if you want to edit rows.

## HTTP API

| Method   | Endpoint                          | Description                                        |
| -------- | --------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/health`                     | DB connectivity check                              |
| `GET`    | `/api/tables`                     | List tables (main tables flagged)                  |
| `GET`    | `/api/tables/:table/schema`       | Columns, types, nullability, primary key           |
| `GET`    | `/api/tables/:table/rows`         | Rows; query: `limit`, `offset`, `order`, `dir`, `q`, `f_<column>` (quickfilter, `__NULL__` for NULL) |
| `GET`    | `/api/tables/:table/column-values/:column` | Distinct values of a quickfilter column |
| `GET`    | `/api/tables/:table/lookup/:column` | Value/label options for a lookup column |
| `POST`   | `/api/tables/:table/rows`         | Insert row — body: `{ "values": { col: val } }`    |
| `PUT`    | `/api/tables/:table/rows`         | Update row — body: `{ "pk": {...}, "values": {...} }` |
| `DELETE` | `/api/tables/:table/rows`         | Delete row — body: `{ "pk": {...} }`               |
| `POST`   | `/api/schema/refresh`             | Drop the schema cache (after DDL changes)          |

All table/column identifiers are validated against the live schema, and all values are
sent as bound parameters — no string-built SQL for values.

## Project layout

```
webapp/
├── server.js                  # Express entry point
├── config.example.json        # Configuration template
├── src/
│   ├── config.js              # Config file loading + validation
│   ├── db.js                  # pg connection pool
│   ├── schema.js              # information_schema introspection (cached)
│   └── api.js                 # REST API (generic table CRUD)
├── public/
│   ├── index.html             # Vue.js single page app
│   ├── app.js
│   └── style.css
└── install/
    ├── install.sh             # Raspberry Pi installer
    ├── uninstall.sh
    └── osh-webapp.service     # systemd unit template
```
