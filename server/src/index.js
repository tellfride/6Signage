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

// ---------- Auto-update dos players ----------
const hashCache = new Map(); // path -> { mtime, size, sha256 }
function fileMeta(file) {
  const st = fs.statSync(file);
  const c = hashCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const meta = { mtime: st.mtimeMs, size: st.size, sha256 };
  hashCache.set(file, meta);
  return meta;
}

// O player consulta a versão mais recente para a sua plataforma (win | android)
app.get('/api/player/version', (req, res) => {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'player-version.json'), 'utf8')); }
  catch { return res.status(500).json({ error: 'Configuração de versão indisponível' }); }
  const info = cfg[req.query.platform];
  if (!info) return res.status(400).json({ error: 'Plataforma inválida (use win ou android)' });
  const out = { ...info };
  const file = path.join(__dirname, '..', 'downloads', path.basename(info.url));
  if (fs.existsSync(file)) {
    const m = fileMeta(file);
    out.size = m.size;
    out.sha256 = m.sha256;
  } else {
    out.available = false;
  }
  res.json(out);
});

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
  const devices = db.prepare(`
    SELECT d.*, g.name AS group_name, p.name AS playlist_name,
           s.city AS sidebar_city, s.lat AS sidebar_lat, s.lon AS sidebar_lon
    FROM devices d
    LEFT JOIN device_groups g ON g.id = d.group_id
    LEFT JOIN playlists p ON p.id = d.playlist_id
    LEFT JOIN sidebars s ON s.id = d.sidebar_id
    ORDER BY d.name`).all();

  // Dados para o espelho da tela no painel: frame no ar, clima e rodapé
  const byFile = new Map(db.prepare('SELECT file_path, file_type FROM media').all()
    .map(m => [m.file_path.split('/').pop(), m]));
  const tickerText = db.prepare(`SELECT t.text FROM device_tickers dt
      JOIN tickers t ON t.id = dt.ticker_id WHERE dt.device_id = ? ORDER BY t.name`);
  for (const d of devices) {
    const cm = d.current_media && byFile.get(d.current_media);
    if (cm) { d.current_media_path = cm.file_path; d.current_media_type = cm.file_type; }
    const tk = tickerText.all(d.id).map(r => (r.text || '').trim()).filter(Boolean);
    d.ticker_count = tk.length;
    d.ticker_preview = tk.join('\n').split('\n').map(s => s.trim()).filter(Boolean).join(' · ');
    if (d.sidebar_lat != null && d.sidebar_lon != null) {
      // só o que já está em cache — nunca busca durante a listagem
      const c = weatherCache.get(`${d.sidebar_lat.toFixed(3)},${d.sidebar_lon.toFixed(3)}`);
      if (c) d.sidebar_temp = c.data.temp;
    }
  }
  res.json(devices);
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
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=2&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const c = j.current || {};
    const dly = j.daily || {};
    const data = {
      temp: Math.round(c.temperature_2m),
      code: c.weather_code,
      humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m)
    };
    // índice 1 = amanhã (forecast_days=2 devolve hoje e amanhã)
    if (dly.temperature_2m_max && dly.temperature_2m_max.length > 1) {
      data.tomorrow = {
        max: Math.round(dly.temperature_2m_max[1]),
        min: Math.round(dly.temperature_2m_min[1]),
        code: dly.weather_code ? dly.weather_code[1] : null
      };
    }
    weatherCache.set(key, { ts: Date.now(), data });
    return data;
  } catch {
    return cached ? cached.data : null; // em falha de rede, devolve o último conhecido
  }
}

// Busca por CEP (BrasilAPI; se não vier coordenada, geocodifica a cidade)
app.get('/api/weather/cep', auth, async (req, res) => {
  const cep = String(req.query.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ error: 'CEP deve ter 8 dígitos' });
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(404).json({ error: 'CEP não encontrado' });
    const j = await r.json();
    const coords = j.location && j.location.coordinates;
    let lat = coords && coords.latitude ? Number(coords.latitude) : null;
    let lon = coords && coords.longitude ? Number(coords.longitude) : null;
    if (lat == null || lon == null) { // fallback: geocodifica cidade/UF
      const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=` +
        `${encodeURIComponent(j.city)}&count=1&language=pt&format=json`, { signal: AbortSignal.timeout(8000) });
      const gj = await g.json();
      const hit = (gj.results || [])[0];
      if (!hit) return res.status(404).json({ error: 'Não foi possível localizar o CEP no mapa' });
      lat = hit.latitude; lon = hit.longitude;
    }
    res.json({
      city: j.city, region: j.state, neighborhood: j.neighborhood || '',
      street: j.street || '', postal_code: cep, lat, lon
    });
  } catch {
    res.status(502).json({ error: 'Não foi possível consultar o CEP agora' });
  }
});

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

// Telas que o usuário pode alterar (admin: todas; editor: só dos seus grupos)
function filterAllowedDevices(user, ids) {
  const allowed = allowedGroups(user);
  if (!allowed) return ids;
  if (!allowed.length) return [];
  const ph = allowed.map(() => '?').join(',');
  const ok = db.prepare(`SELECT id FROM devices WHERE group_id IN (${ph})`).all(...allowed).map(r => r.id);
  return ids.filter(id => ok.includes(id));
}
function canEditDevice(user, device) {
  const allowed = allowedGroups(user);
  return !allowed || (device.group_id && allowed.includes(device.group_id));
}

// ---------- Faixas de rodapé (avisos) ----------
app.get('/api/tickers', auth, (req, res) => {
  const list = db.prepare('SELECT * FROM tickers ORDER BY name').all();
  for (const t of list)
    t.device_ids = db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?')
      .all(t.id).map(r => r.device_id);
  res.json(list);
});

app.post('/api/tickers', auth, canWrite, (req, res) => {
  const { name, text } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Dê um nome à faixa' });
  const id = uuid();
  db.prepare('INSERT INTO tickers (id, name, text) VALUES (?,?,?)').run(id, name, text || '');
  res.status(201).json(db.prepare('SELECT * FROM tickers WHERE id = ?').get(id));
});

app.put('/api/tickers/:id', auth, canWrite, (req, res) => {
  const t = db.prepare('SELECT id FROM tickers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Faixa não encontrada' });
  const { name, text } = req.body || {};
  db.prepare('UPDATE tickers SET name = COALESCE(?, name), text = COALESCE(?, text) WHERE id = ?')
    .run(name ?? null, text ?? null, t.id);
  db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?').all(t.id)
    .forEach(r => notifyDevice(r.device_id));
  res.json({ ok: true });
});

app.delete('/api/tickers/:id', auth, canWrite, (req, res) => {
  const devs = db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?').all(req.params.id);
  db.prepare('DELETE FROM tickers WHERE id = ?').run(req.params.id);
  devs.forEach(r => notifyDevice(r.device_id));
  res.json({ ok: true });
});

// Atribuir a faixa a telas: uma, várias ou todas (envie a lista de ids)
app.put('/api/tickers/:id/devices', auth, canWrite, (req, res) => {
  const t = db.prepare('SELECT id FROM tickers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Faixa não encontrada' });
  const wanted = filterAllowedDevices(req.user, req.body.device_ids || []);
  const before = db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?').all(t.id).map(r => r.device_id);
  const editable = filterAllowedDevices(req.user, before);
  db.exec('BEGIN');
  try {
    // remove apenas os vínculos que o usuário pode mexer
    const del = db.prepare('DELETE FROM device_tickers WHERE ticker_id = ? AND device_id = ?');
    editable.forEach(id => del.run(t.id, id));
    const ins = db.prepare('INSERT OR IGNORE INTO device_tickers (device_id, ticker_id) VALUES (?,?)');
    wanted.forEach(id => ins.run(id, t.id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  new Set([...before, ...wanted]).forEach(id => notifyDevice(id));
  res.json({ ok: true, count: wanted.length });
});

// ---------- Perfis de barra lateral (clima) ----------
app.get('/api/sidebars', auth, (req, res) => {
  const list = db.prepare('SELECT * FROM sidebars ORDER BY name').all();
  for (const s of list)
    s.device_ids = db.prepare('SELECT id FROM devices WHERE sidebar_id = ?').all(s.id).map(r => r.id);
  res.json(list);
});

app.post('/api/sidebars', auth, canWrite, (req, res) => {
  const { name, city, postal_code, lat, lon, show_tomorrow } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Dê um nome ao perfil' });
  if (lat == null || lon == null) return res.status(400).json({ error: 'Escolha a cidade ou informe o CEP' });
  const id = uuid();
  db.prepare(`INSERT INTO sidebars (id, name, city, postal_code, lat, lon, show_tomorrow)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, name, city || null, postal_code || null, lat, lon, show_tomorrow === false ? 0 : 1);
  res.status(201).json(db.prepare('SELECT * FROM sidebars WHERE id = ?').get(id));
});

app.put('/api/sidebars/:id', auth, canWrite, (req, res) => {
  const s = db.prepare('SELECT id FROM sidebars WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Perfil não encontrado' });
  const b = req.body || {};
  db.prepare(`UPDATE sidebars SET name = COALESCE(?, name), city = COALESCE(?, city),
      postal_code = COALESCE(?, postal_code), lat = COALESCE(?, lat), lon = COALESCE(?, lon),
      show_tomorrow = COALESCE(?, show_tomorrow) WHERE id = ?`)
    .run(b.name ?? null, b.city ?? null, b.postal_code ?? null, b.lat ?? null, b.lon ?? null,
         b.show_tomorrow === undefined ? null : (b.show_tomorrow ? 1 : 0), s.id);
  db.prepare('SELECT id FROM devices WHERE sidebar_id = ?').all(s.id).forEach(r => notifyDevice(r.id));
  res.json({ ok: true });
});

app.delete('/api/sidebars/:id', auth, canWrite, (req, res) => {
  const devs = db.prepare('SELECT id FROM devices WHERE sidebar_id = ?').all(req.params.id);
  db.prepare('DELETE FROM sidebars WHERE id = ?').run(req.params.id);
  devs.forEach(r => notifyDevice(r.id));
  res.json({ ok: true });
});

// Atribuir o perfil de clima a telas (uma, várias ou todas)
app.put('/api/sidebars/:id/devices', auth, canWrite, (req, res) => {
  const s = db.prepare('SELECT id FROM sidebars WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Perfil não encontrado' });
  const wanted = filterAllowedDevices(req.user, req.body.device_ids || []);
  const before = db.prepare('SELECT id FROM devices WHERE sidebar_id = ?').all(s.id).map(r => r.id);
  const editable = filterAllowedDevices(req.user, before);
  db.exec('BEGIN');
  try {
    const clear = db.prepare('UPDATE devices SET sidebar_id = NULL WHERE id = ?');
    editable.forEach(id => clear.run(id));
    const set = db.prepare('UPDATE devices SET sidebar_id = ? WHERE id = ?');
    wanted.forEach(id => set.run(s.id, id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  new Set([...before, ...wanted]).forEach(id => notifyDevice(id));
  res.json({ ok: true, count: wanted.length });
});

// Layout da tela: perfil de clima, faixas de rodapé e tamanhos
app.put('/api/devices/:id/layout', auth, canWrite, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Tela não encontrada' });
  if (!canEditDevice(req.user, d))
    return res.status(403).json({ error: 'Você não tem permissão para editar esta tela' });
  const b = req.body || {};
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };
  db.prepare(`UPDATE devices SET sidebar_id = ?, sidebar_width = ?, ticker_height = ? WHERE id = ?`)
    .run(b.sidebar_id || null,
         clamp(b.sidebar_width, 10, 45, 22),
         clamp(b.ticker_height, 6, 30, 12), d.id);
  if (Array.isArray(b.ticker_ids)) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM device_tickers WHERE device_id = ?').run(d.id);
      const ins = db.prepare('INSERT OR IGNORE INTO device_tickers (device_id, ticker_id) VALUES (?,?)');
      b.ticker_ids.forEach(tid => ins.run(d.id, tid));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  notifyDevice(d.id);
  res.json({ ok: true });
});

async function buildLayout(d) {
  const layout = {
    weather: { enabled: false, width: d.sidebar_width || 22, city: '' },
    ticker: { enabled: false, height: d.ticker_height || 12, text: '' }
  };
  if (d.sidebar_id) {
    const s = db.prepare('SELECT * FROM sidebars WHERE id = ?').get(d.sidebar_id);
    if (s) {
      layout.weather.enabled = true;
      layout.weather.city = s.city || s.name;
      layout.weather.show_tomorrow = !!s.show_tomorrow;
      if (s.lat != null && s.lon != null) {
        const w = await getWeather(s.lat, s.lon);
        if (w) {
          Object.assign(layout.weather, w);
          if (!s.show_tomorrow) delete layout.weather.tomorrow;
        }
      }
    }
  }
  // todas as faixas atribuídas a esta tela viram um fluxo único de mensagens
  const text = db.prepare(`SELECT t.text FROM device_tickers dt
      JOIN tickers t ON t.id = dt.ticker_id
      WHERE dt.device_id = ? ORDER BY t.name`).all(d.id)
    .map(r => (r.text || '').trim()).filter(Boolean).join('\n');
  if (text) { layout.ticker.enabled = true; layout.ticker.text = text; }
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
