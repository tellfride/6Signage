const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';
const MEDIA_DIR = path.join(__dirname, '..', 'media');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/media', express.static(MEDIA_DIR));
app.use('/downloads', express.static(path.join(__dirname, '..', 'downloads')));

app.get('/api/health', (req, res) =>
  res.json({ app: '6signage', version: require('../package.json').version }));

// ---------- Autenticação ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// Exige um dos papéis informados (viewer é somente leitura)
function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next()
      : res.status(403).json({ error: 'Sem permissão para esta ação' });
}
const canWrite = requireRole('admin', 'manager');
const adminOnly = requireRole('admin');

// Grupos em que o usuário pode publicar (admin: todos)
function allowedGroups(user) {
  if (user.role === 'admin') return null; // null = sem restrição
  return db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?')
    .all(user.id).map(r => r.group_id);
}

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'Credenciais inválidas' });
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ---------- Usuários (somente admin) ----------
app.get('/api/users', auth, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY email').all();
  for (const u of users) {
    u.groups = db.prepare(`SELECT g.id, g.name FROM user_groups ug
                           JOIN device_groups g ON g.id = ug.group_id
                           WHERE ug.user_id = ?`).all(u.id);
  }
  res.json(users);
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { email, password, role, group_ids } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
  if (!['admin', 'manager', 'viewer'].includes(role)) return res.status(400).json({ error: 'Papel inválido' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Já existe um usuário com este e-mail' });
  const id = uuid();
  db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?,?,?,?)')
    .run(id, email, bcrypt.hashSync(password, 10), role);
  const ins = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?,?)');
  (group_ids || []).forEach(g => ins.run(id, g));
  res.status(201).json({ id, email, role });
});

app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { role, password, group_ids } = req.body || {};
  if (role && u.id === req.user.id && role !== 'admin')
    return res.status(400).json({ error: 'Você não pode rebaixar o próprio papel' });
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), u.id);
  if (Array.isArray(group_ids)) {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(u.id);
    const ins = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?,?)');
    group_ids.forEach(g => ins.run(u.id, g));
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'Você não pode excluir a si mesmo' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Mídia ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`)
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp4|mkv|webm|jpg|jpeg|png|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Formato não suportado'), ok);
  }
});

app.get('/api/media', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM media ORDER BY uploaded_at DESC').all());
});

app.post('/api/media/upload', auth, canWrite, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo ausente' });
  const isVideo = /\.(mp4|mkv|webm)$/i.test(req.file.filename);
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
  const id = uuid();
  db.prepare(`INSERT INTO media (id, filename, file_path, file_type, duration_seconds, file_size, checksum)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.file.originalname, `/media/${req.file.filename}`,
         isVideo ? 'video' : 'image', isVideo ? null : 10, req.file.size, checksum);
  res.status(201).json(db.prepare('SELECT * FROM media WHERE id = ?').get(id));
});

app.delete('/api/media/:id', auth, canWrite, (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Não encontrado' });
  const abs = path.join(MEDIA_DIR, path.basename(m.file_path));
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Playlists ----------
app.get('/api/playlists', auth, (req, res) => {
  const lists = db.prepare('SELECT * FROM playlists ORDER BY created_at DESC').all();
  for (const p of lists) {
    p.items = db.prepare(`
      SELECT pi.*, m.filename, m.file_path, m.file_type, m.duration_seconds, m.checksum
      FROM playlist_items pi JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = ? ORDER BY pi.position`).all(p.id);
  }
  res.json(lists);
});

app.post('/api/playlists', auth, canWrite, (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const id = uuid();
  db.prepare('INSERT INTO playlists (id, name, description) VALUES (?,?,?)').run(id, name, description || null);
  res.status(201).json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id));
});

// Substitui todos os itens da playlist (ordem enviada = ordem final)
app.put('/api/playlists/:id/items', auth, canWrite, (req, res) => {
  const p = db.prepare('SELECT id FROM playlists WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist não encontrada' });
  const items = req.body.items || [];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(p.id);
    const ins = db.prepare(`INSERT INTO playlist_items (id, playlist_id, media_id, duration_override, position, transition_type)
                            VALUES (?,?,?,?,?,?)`);
    items.forEach((it, i) =>
      ins.run(uuid(), p.id, it.media_id, it.duration_override || null, i, it.transition_type || 'fade'));
    db.prepare(`UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`).run(p.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  notifyPlaylistDevices(p.id);
  res.json({ ok: true, count: items.length });
});

app.delete('/api/playlists/:id', auth, canWrite, (req, res) => {
  db.prepare('UPDATE devices SET playlist_id = NULL WHERE playlist_id = ?').run(req.params.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Atribuir playlist a dispositivo ou grupo
app.post('/api/playlists/:id/assign', auth, canWrite, (req, res) => {
  const { device_id, group_id } = req.body || {};
  if (!device_id && !group_id) return res.status(400).json({ error: 'Informe device_id ou group_id' });
  const allowed = allowedGroups(req.user);
  if (allowed) { // manager: valida permissão de publicação no grupo
    const target = group_id ||
      (db.prepare('SELECT group_id FROM devices WHERE id = ?').get(device_id) || {}).group_id;
    if (!target || !allowed.includes(target))
      return res.status(403).json({ error: 'Você não tem permissão para publicar neste grupo' });
  }
  if (device_id) {
    db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(req.params.id, device_id);
    notifyDevice(device_id);
  } else {
    db.prepare('UPDATE devices SET playlist_id = ? WHERE group_id = ?').run(req.params.id, group_id);
    db.prepare('SELECT id FROM devices WHERE group_id = ?').all(group_id).forEach(d => notifyDevice(d.id));
  }
  res.json({ ok: true });
});

// ---------- Grupos ----------
app.get('/api/groups', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM device_groups ORDER BY name').all()));

app.post('/api/groups', auth, adminOnly, (req, res) => {
  const id = uuid();
  db.prepare('INSERT INTO device_groups (id, name, description) VALUES (?,?,?)')
    .run(id, req.body.name, req.body.description || null);
  res.status(201).json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id));
});

app.delete('/api/groups/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM device_groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Dispositivos ----------
app.get('/api/devices', auth, (req, res) => {
  const cutoff = new Date(Date.now() - 90_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`UPDATE devices SET status='offline' WHERE last_heartbeat IS NULL OR last_heartbeat < ?`).run(cutoff);
  res.json(db.prepare(`
    SELECT d.*, g.name AS group_name, p.name AS playlist_name
    FROM devices d
    LEFT JOIN device_groups g ON g.id = d.group_id
    LEFT JOIN playlists p ON p.id = d.playlist_id
    ORDER BY d.name`).all());
});

app.put('/api/devices/:id', auth, canWrite, (req, res) => {
  const { name, location, group_id, approved } = req.body || {};
  db.prepare(`UPDATE devices SET
      name = COALESCE(?, name), location = COALESCE(?, location),
      group_id = COALESCE(?, group_id), approved = COALESCE(?, approved)
      WHERE id = ?`)
    .run(name ?? null, location ?? null, group_id ?? null,
         approved === undefined ? null : (approved ? 1 : 0), req.params.id);
  res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id));
});

app.delete('/api/devices/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/devices/:id/command', auth, canWrite, (req, res) => {
  const sent = sendToDevice(req.params.id, { type: 'command', command: req.body.command });
  res.json({ ok: sent, delivered: sent });
});

// ---------- API do Player (sem JWT; autentica por device_key) ----------
app.post('/api/devices/register', (req, res) => {
  const { device_key, device_name, resolution, os_version, client_version } = req.body || {};
  if (!device_key) return res.status(400).json({ error: 'device_key obrigatório' });
  let d = db.prepare('SELECT * FROM devices WHERE device_key = ?').get(device_key);
  if (!d) {
    const id = uuid();
    db.prepare(`INSERT INTO devices (id, name, device_key, resolution, os_version, client_version, status)
                VALUES (?,?,?,?,?,?, 'online')`)
      .run(id, device_name || 'Novo dispositivo', device_key, resolution || null, os_version || null, client_version || null);
    d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  } else {
    db.prepare(`UPDATE devices SET resolution = COALESCE(?, resolution),
                os_version = COALESCE(?, os_version), client_version = COALESCE(?, client_version)
                WHERE id = ?`).run(resolution, os_version, client_version, d.id);
  }
  res.json({ device_id: d.id, approved: !!d.approved });
});

// ---------- Clima (Open-Meteo, gratuito e sem chave de API) ----------
const weatherCache = new Map(); // "lat,lon" -> { ts, data }
async function getWeather(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.ts < 15 * 60 * 1000) return cached.data;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const c = j.current || {};
    const data = {
      temp: Math.round(c.temperature_2m),
      code: c.weather_code,
      humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m)
    };
    weatherCache.set(key, { ts: Date.now(), data });
    return data;
  } catch {
    return cached ? cached.data : null; // em falha de rede, devolve o último conhecido
  }
}

// Busca de localidade para o editor (autocompletar cidade)
app.get('/api/weather/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}` +
      `&count=6&language=pt&format=json`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    res.json((j.results || []).map(x => ({
      name: x.name, region: x.admin1 || '', country: x.country_code || '',
      lat: x.latitude, lon: x.longitude
    })));
  } catch {
    res.status(502).json({ error: 'Não foi possível buscar a localidade agora' });
  }
});

// Salvar layout/overlays de uma tela (painel de clima + rodapé de avisos)
app.put('/api/devices/:id/layout', auth, canWrite, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Tela não encontrada' });
  const allowed = allowedGroups(req.user);
  if (allowed && (!d.group_id || !allowed.includes(d.group_id)))
    return res.status(403).json({ error: 'Você não tem permissão para editar esta tela' });
  const b = req.body || {};
  db.prepare(`UPDATE devices SET
      weather_enabled = ?, weather_location = ?, weather_lat = ?, weather_lon = ?,
      ticker_enabled = ?, ticker_text = ? WHERE id = ?`)
    .run(b.weather_enabled ? 1 : 0, b.weather_location || null,
         b.weather_lat ?? null, b.weather_lon ?? null,
         b.ticker_enabled ? 1 : 0, b.ticker_text || null, d.id);
  notifyDevice(d.id);
  res.json({ ok: true });
});

async function buildLayout(d) {
  const layout = {
    weather: { enabled: !!d.weather_enabled, city: d.weather_location || '' },
    ticker: { enabled: !!d.ticker_enabled, text: d.ticker_text || '' }
  };
  if (d.weather_enabled && d.weather_lat != null && d.weather_lon != null) {
    const w = await getWeather(d.weather_lat, d.weather_lon);
    if (w) Object.assign(layout.weather, w);
  }
  return layout;
}

async function buildManifest(device) {
  const layout = await buildLayout(device);
  if (!device.approved || !device.playlist_id)
    return { playlist: null, items: [], sync_interval: 60, layout };
  const playlist = db.prepare('SELECT id, name, updated_at FROM playlists WHERE id = ?').get(device.playlist_id);
  const items = db.prepare(`
    SELECT m.id AS media_id, m.file_path AS url, m.file_type, m.checksum,
           COALESCE(pi.duration_override, m.duration_seconds, 10) AS duration,
           pi.transition_type
    FROM playlist_items pi JOIN media m ON m.id = pi.media_id
    WHERE pi.playlist_id = ? ORDER BY pi.position`).all(device.playlist_id);
  return { playlist, items, sync_interval: 60, layout };
}

app.get('/api/player/manifest', async (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE device_key = ?').get(req.query.device_key);
  if (!d) return res.status(404).json({ error: 'Dispositivo não registrado' });
  res.json(await buildManifest(d));
});

app.post('/api/player/heartbeat', (req, res) => {
  const { device_key, current_media, status } = req.body || {};
  const d = db.prepare('SELECT id FROM devices WHERE device_key = ?').get(device_key);
  if (!d) return res.status(404).json({ error: 'Dispositivo não registrado' });
  db.prepare(`UPDATE devices SET status = ?, current_media = ?, last_heartbeat = datetime('now') WHERE id = ?`)
    .run(status || 'online', current_media || null, d.id);
  res.json({ ok: true });
});

// ---------- WebSocket (push para players e dashboard) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const deviceSockets = new Map(); // device_id -> ws

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const key = params.get('device_key');
  if (key) {
    const d = db.prepare('SELECT id FROM devices WHERE device_key = ?').get(key);
    if (d) {
      deviceSockets.set(d.id, ws);
      db.prepare(`UPDATE devices SET status='online', last_heartbeat=datetime('now') WHERE id=?`).run(d.id);
      ws.on('close', () => {
        if (deviceSockets.get(d.id) === ws) deviceSockets.delete(d.id);
        db.prepare(`UPDATE devices SET status='offline' WHERE id=?`).run(d.id);
      });
    }
  }
});

function sendToDevice(deviceId, msg) {
  const ws = deviceSockets.get(deviceId);
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}
function notifyDevice(deviceId) { sendToDevice(deviceId, { type: 'manifest_updated' }); }
function notifyPlaylistDevices(playlistId) {
  db.prepare('SELECT id FROM devices WHERE playlist_id = ?').all(playlistId)
    .forEach(d => notifyDevice(d.id));
}

server.listen(PORT, () =>
  console.log(`6Signage server rodando em http://0.0.0.0:${PORT}`));
