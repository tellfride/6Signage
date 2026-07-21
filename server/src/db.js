const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const db = new DatabaseSync(path.join(__dirname, '..', '6signage.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','manager','viewer')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  device_key TEXT UNIQUE NOT NULL,
  location TEXT,
  resolution TEXT,
  os_version TEXT,
  client_version TEXT,
  status TEXT DEFAULT 'offline' CHECK (status IN ('online','offline','error')),
  last_heartbeat TEXT,
  current_media TEXT,
  group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
  playlist_id TEXT,
  approved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('video','image')),
  duration_seconds INTEGER DEFAULT 10,
  file_size INTEGER,
  checksum TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  duration_override INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  transition_type TEXT DEFAULT 'fade' CHECK (transition_type IN ('fade','slide','cut'))
);

-- Permissões: em quais grupos um usuário 'manager' pode publicar
CREATE TABLE IF NOT EXISTS user_groups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  playlist_id TEXT,
  media_id TEXT,
  status TEXT,
  error_message TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_playlist ON playlist_items(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_logs_device ON execution_logs(device_id, timestamp);
`);

// Faixas de rodapé (avisos) — reutilizáveis, N:N com telas
db.exec(`
CREATE TABLE IF NOT EXISTS tickers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_tickers (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ticker_id TEXT NOT NULL REFERENCES tickers(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, ticker_id)
);

-- Perfis de barra lateral (clima) — um perfil serve várias telas
CREATE TABLE IF NOT EXISTS sidebars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  postal_code TEXT,
  lat REAL,
  lon REAL,
  show_tomorrow INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Perfis de LAYOUT (tamanho + aparência) — atrelável a um grupo inteiro ou a uma tela
CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sidebar_width INTEGER DEFAULT 22,
  ticker_height INTEGER DEFAULT 12,
  orientation TEXT DEFAULT 'auto' CHECK (orientation IN ('auto','landscape','portrait')),
  sidebar_bg_mode TEXT DEFAULT 'auto' CHECK (sidebar_bg_mode IN ('auto','color','image')),
  sidebar_bg_color TEXT,
  sidebar_bg_image TEXT,
  sidebar_bg_checksum TEXT,
  ticker_bg_mode TEXT DEFAULT 'auto' CHECK (ticker_bg_mode IN ('auto','color','image')),
  ticker_bg_color TEXT,
  ticker_bg_image TEXT,
  ticker_bg_checksum TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migração: colunas de layout/overlays por dispositivo
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// legado (v0.3): configuração de clima/rodapé direto no dispositivo
ensureColumn('devices', 'weather_enabled', 'INTEGER DEFAULT 0');
ensureColumn('devices', 'weather_location', 'TEXT');
ensureColumn('devices', 'weather_lat', 'REAL');
ensureColumn('devices', 'weather_lon', 'REAL');
ensureColumn('devices', 'ticker_enabled', 'INTEGER DEFAULT 0');
ensureColumn('devices', 'ticker_text', 'TEXT');
// v0.4: perfis reutilizáveis + tamanhos ajustáveis
ensureColumn('devices', 'sidebar_id', 'TEXT REFERENCES sidebars(id) ON DELETE SET NULL');
ensureColumn('devices', 'sidebar_width', 'INTEGER DEFAULT 22');
ensureColumn('devices', 'ticker_height', 'INTEGER DEFAULT 12');
// v1.2: perfil de LAYOUT atrelável a um grupo (default) ou a uma tela (override explícito)
ensureColumn('devices', 'layout_id', 'TEXT REFERENCES layouts(id) ON DELETE SET NULL');
ensureColumn('device_groups', 'layout_id', 'TEXT REFERENCES layouts(id) ON DELETE SET NULL');

// Converte a configuração antiga (por dispositivo) em perfis reutilizáveis.
// Roda uma única vez: limpa os flags legados ao final de cada conversão.
const legacy = db.prepare(`SELECT * FROM devices
  WHERE (weather_enabled = 1 AND weather_lat IS NOT NULL)
     OR (ticker_enabled = 1 AND ticker_text IS NOT NULL AND ticker_text <> '')`).all();
for (const d of legacy) {
  if (d.weather_enabled && d.weather_lat != null) {
    const sid = crypto.randomUUID();
    db.prepare(`INSERT INTO sidebars (id, name, city, lat, lon) VALUES (?,?,?,?,?)`)
      .run(sid, d.weather_location || d.name, d.weather_location, d.weather_lat, d.weather_lon);
    db.prepare('UPDATE devices SET sidebar_id = ? WHERE id = ?').run(sid, d.id);
  }
  if (d.ticker_enabled && d.ticker_text) {
    const tid = crypto.randomUUID();
    db.prepare('INSERT INTO tickers (id, name, text) VALUES (?,?,?)')
      .run(tid, 'Avisos — ' + d.name, d.ticker_text);
    db.prepare('INSERT OR IGNORE INTO device_tickers (device_id, ticker_id) VALUES (?,?)').run(d.id, tid);
  }
  db.prepare('UPDATE devices SET weather_enabled = 0, ticker_enabled = 0 WHERE id = ?').run(d.id);
}
if (legacy.length) console.log(`[migração] ${legacy.length} tela(s) convertida(s) para perfis reutilizáveis`);

module.exports = db;
