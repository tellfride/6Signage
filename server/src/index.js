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
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const cron = require('node-cron');
const { sendWhatsApp } = require('./whatsapp');
const db = require('./db');

const PORT = process.env.PORT || 3000;

// Sem JWT_SECRET: em produção o servidor recusa iniciar (nunca roda com um
// segredo previsível); em desenvolvimento gera um valor aleatório por processo
// (não fica fixo no código-fonte, mas também não trava quem só quer testar).
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET não definido. Defina a variável de ambiente antes de iniciar em produção.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[dev] JWT_SECRET não definido — usando um segredo aleatório só para esta execução.');
}

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const BG_DIR = path.join(__dirname, '..', 'backgrounds');
fs.mkdirSync(BG_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // necessário p/ rate-limit por IP funcionar correto detrás do nginx (ver README)
app.use(helmet({ contentSecurityPolicy: false })); // CSP fica para depois, calibrada com o domínio do Turnstile
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/media', express.static(MEDIA_DIR));
app.use('/backgrounds', express.static(BG_DIR));
app.use('/downloads', express.static(path.join(__dirname, '..', 'downloads')));

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}
// Dias entre hoje e uma data 'YYYY-MM-DD' (negativo = já passou).
function daysUntil(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round((new Date(dateStr + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
}

// Perfil de layout que efetivamente comanda a aparência da tela:
// override na própria tela > padrão do grupo > nenhum (cai nas colunas legadas).
function pickLayout(d) {
  if (d.layout_id) {
    const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(d.layout_id);
    if (L) return L;
  }
  if (d.group_id) {
    const g = db.prepare('SELECT layout_id FROM device_groups WHERE id = ?').get(d.group_id);
    if (g && g.layout_id) {
      const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(g.layout_id);
      if (L) return L;
    }
  }
  return null;
}
// Sem perfil explícito, infere pela resolução reportada pelo próprio player
// (ex.: "1080x1920" → retrato) — cobre o parque de telas sem exigir configuração.
function inferOrientation(resolution) {
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(resolution || '');
  if (!m) return 'landscape';
  return Number(m[2]) > Number(m[1]) ? 'portrait' : 'landscape';
}
function resolveOrientation(layout, resolution) {
  if (layout && layout.orientation && layout.orientation !== 'auto') return layout.orientation;
  return inferOrientation(resolution);
}
// Notifica as telas afetadas por uma mudança no perfil: as com override direto
// e as que herdam por estarem num grupo que usa este perfil como padrão.
function notifyLayoutDevices(layoutId) {
  db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(layoutId).forEach(r => notifyDevice(r.id));
  db.prepare(`SELECT d.id FROM devices d JOIN device_groups g ON g.id = d.group_id
              WHERE g.layout_id = ? AND d.layout_id IS NULL`).all(layoutId).forEach(r => notifyDevice(r.id));
}

app.get('/api/health', (req, res) =>
  res.json({ app: 'vitrinion', version: require('../package.json').version }));

// Config pública mínima para o front-end montar o widget de captcha sem build step.
app.get('/api/config', (req, res) => {
  res.json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    version: require('../package.json').version
  });
});

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
// Empresa suspensa manualmente ou com assinatura vencida: bloqueia login e
// qualquer chamada de API para quem não é super_admin. Não afeta as rotas do
// player (register/manifest/heartbeat/ws), que não passam por auth() — as
// telas continuam exibindo o último conteúdo mesmo com a empresa vencida.
function companyBlockReason(companyId) {
  if (!companyId) return null;
  const c = db.prepare('SELECT active, due_date FROM companies WHERE id = ?').get(companyId);
  if (!c) return null;
  if (!c.active) return { status: 403, error: 'Empresa suspensa. Entre em contato com o suporte.' };
  if (c.due_date && c.due_date < new Date().toISOString().slice(0, 10))
    return { status: 402, error: 'Assinatura vencida. Entre em contato para renovar o acesso.' };
  return null;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  if (req.user.role !== 'super_admin') {
    const blocked = companyBlockReason(req.user.company_id);
    if (blocked) return res.status(blocked.status).json({ error: blocked.error });
  }
  next();
}

// Exige um dos papéis informados (viewer é somente leitura). super_admin
// passa em qualquer checagem — é um superconjunto de admin.
function requireRole(...roles) {
  return (req, res, next) =>
    (roles.includes(req.user.role) || req.user.role === 'super_admin') ? next()
      : res.status(403).json({ error: 'Sem permissão para esta ação' });
}
const canWrite = requireRole('admin', 'manager');
const adminOnly = requireRole('admin');
const superAdminOnly = requireRole('super_admin');

// Grupos em que o usuário pode publicar (admin/super_admin: todos os da empresa)
function allowedGroups(user) {
  if (user.role === 'admin' || user.role === 'super_admin') return null; // null = sem restrição
  return db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?')
    .all(user.id).map(r => r.group_id);
}

// ---------- Multi-tenancy ----------
// Empresa em nome de quem a requisição age: para papéis normais, é sempre a
// própria empresa do token (nunca confia em nada vindo do cliente); só o
// super_admin pode "agir como" uma empresa específica, escolhida no painel
// e enviada neste header — sem ele, super_admin lista tudo sem filtro.
function companyCtx(req) {
  if (req.user.role !== 'super_admin') return req.user.company_id;
  const hdr = req.headers['x-company-id'];
  return hdr || null;
}
// Dono de uma linha com company_id obrigatório (users, groups, media, playlists,
// tickers, sidebars, layouts): super_admin é dono de tudo, sempre.
function ownedRow(user, row) {
  return user.role === 'super_admin' || row.company_id === user.company_id;
}
// Dispositivos têm company_id nullable (pendente de aprovação = de ninguém
// ainda, qualquer admin da empresa pode ver/aprovar).
function ownedDevice(user, device) {
  return user.role === 'super_admin' || !device.company_id || device.company_id === user.company_id;
}

async function verifyTurnstile(token, remoteip) {
  if (!process.env.TURNSTILE_SECRET_KEY) return process.env.NODE_ENV !== 'production'; // dev: bypass; prod: fail-closed
  const params = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token || '' });
  if (remoteip) params.append('remoteip', remoteip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: params, signal: AbortSignal.timeout(8000) });
    return !!(await r.json()).success;
  } catch {
    return false; // rede fora do ar: falha fechado, nunca abre bypass
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde alguns minutos.' }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password, captcha_token } = req.body || {};
  if (!(await verifyTurnstile(captcha_token, req.ip)))
    return res.status(400).json({ error: 'Verificação de segurança falhou. Tente novamente.' });

  const user = db.prepare(`SELECT *,
    (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked
    FROM users WHERE email = ?`).get(email);
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

  if (user.is_locked)
    return res.status(423).json({
      error: 'Conta temporariamente bloqueada por tentativas incorretas. Peça a um administrador para desbloquear, ou tente novamente em alguns minutos.'
    });

  if (!bcrypt.compareSync(password || '', user.password_hash)) {
    const attempts = (user.failed_attempts || 0) + 1;
    const lock = attempts >= 3;
    db.prepare(`UPDATE users SET failed_attempts = ?, last_failed_at = datetime('now'),
                locked_until = ${lock ? "datetime('now','+3 minutes')" : 'locked_until'} WHERE id = ?`)
      .run(attempts, user.id);
    return res.status(lock ? 423 : 401).json({
      error: lock ? 'Conta bloqueada por 3 tentativas incorretas. Tente novamente em 3 min.' : 'Credenciais inválidas'
    });
  }

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  if (user.role !== 'super_admin') {
    const blocked = companyBlockReason(user.company_id);
    if (blocked) return res.status(blocked.status).json({ error: blocked.error });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, company_id: user.company_id },
    JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, company_id: user.company_id } });
});

// Troca de senha self-service (qualquer papel) — exige a senha atual, diferente
// do reset feito por um admin em cima da conta de outra pessoa (PUT /users/:id).
app.post('/api/auth/change-password', auth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'A nova senha precisa ter ao menos 6 caracteres' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password || '', user.password_hash))
    return res.status(401).json({ error: 'Senha atual incorreta' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ ok: true });
});

// ---------- Usuários (admin da própria empresa, ou super_admin em qualquer uma) ----------
app.get('/api/users', auth, adminOnly, (req, res) => {
  const cid = companyCtx(req);
  const users = cid
    ? db.prepare(`SELECT id, email, role, company_id, created_at, failed_attempts,
        (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked
        FROM users WHERE company_id = ? ORDER BY email`).all(cid)
    : db.prepare(`SELECT id, email, role, company_id, created_at, failed_attempts,
        (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked
        FROM users ORDER BY email`).all();
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
  const allowedRoles = req.user.role === 'super_admin' ? ['super_admin', 'admin', 'manager', 'viewer'] : ['admin', 'manager', 'viewer'];
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Papel inválido' });
  let cid = null;
  if (role !== 'super_admin') {
    cid = companyCtx(req);
    if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de criar esta conta' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Já existe um usuário com este e-mail' });
  const id = uuid();
  db.prepare('INSERT INTO users (id, email, password_hash, role, company_id) VALUES (?,?,?,?,?)')
    .run(id, email, bcrypt.hashSync(password, 10), role, cid);
  const validGroups = cid
    ? (group_ids || []).filter(g => db.prepare('SELECT id FROM device_groups WHERE id = ? AND company_id = ?').get(g, cid))
    : [];
  const ins = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?,?)');
  validGroups.forEach(g => ins.run(id, g));
  res.status(201).json({ id, email, role, company_id: cid });
});

app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u || !ownedRow(req.user, u)) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { role, password, group_ids } = req.body || {};
  if (role && u.id === req.user.id && role !== u.role)
    return res.status(400).json({ error: 'Você não pode alterar o próprio papel' });
  if (role) {
    if (req.user.role !== 'super_admin' && role === 'super_admin')
      return res.status(403).json({ error: 'Sem permissão para conceder este papel' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  }
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), u.id);
  if (Array.isArray(group_ids) && u.company_id) {
    const validGroups = group_ids.filter(g =>
      db.prepare('SELECT id FROM device_groups WHERE id = ? AND company_id = ?').get(g, u.company_id));
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(u.id);
    const ins = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?,?)');
    validGroups.forEach(g => ins.run(u.id, g));
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'Você não pode excluir a si mesmo' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u || !ownedRow(req.user, u)) return res.status(404).json({ error: 'Usuário não encontrado' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/unlock', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u || !ownedRow(req.user, u)) return res.status(404).json({ error: 'Usuário não encontrado' });
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(u.id);
  res.json({ ok: true });
});

// ---------- Empresas (somente super_admin) ----------
function deviceCount(companyId) {
  return db.prepare('SELECT COUNT(*) n FROM devices WHERE company_id = ? AND approved = 1').get(companyId).n;
}

app.get('/api/companies', auth, superAdminOnly, (req, res) => {
  const list = db.prepare('SELECT * FROM companies ORDER BY name').all();
  for (const c of list) c.device_count = deviceCount(c.id);
  res.json(list);
});

app.post('/api/companies', auth, superAdminOnly, (req, res) => {
  const { name, admin_email, admin_password } = req.body || {};
  if (!name || !admin_email || !admin_password)
    return res.status(400).json({ error: 'Nome, e-mail e senha do admin são obrigatórios' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(admin_email))
    return res.status(409).json({ error: 'Já existe um usuário com este e-mail' });
  const companyId = uuid(), userId = uuid();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO companies (id, name) VALUES (?,?)').run(companyId, name);
    db.prepare('INSERT INTO users (id, email, password_hash, role, company_id) VALUES (?,?,?,?,?)')
      .run(userId, admin_email, bcrypt.hashSync(admin_password, 10), 'admin', companyId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.status(201).json(db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId));
});

app.put('/api/companies/:id', auth, superAdminOnly, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Empresa não encontrada' });
  const b = req.body || {};
  // due_date/screen_limit precisam poder ser explicitamente limpos (voltar a
  // "sem vencimento"/"sem limite"), então usam presença da chave, não COALESCE.
  db.prepare(`UPDATE companies SET
      name = COALESCE(?, name),
      active = COALESCE(?, active),
      due_date = ?,
      screen_limit = ?,
      whatsapp = COALESCE(?, whatsapp),
      message_header = ?,
      last_reminder_stage = CASE WHEN ? THEN NULL ELSE last_reminder_stage END
      WHERE id = ?`)
    .run(
      b.name ?? null,
      b.active === undefined ? null : (b.active ? 1 : 0),
      'due_date' in b ? (b.due_date || null) : c.due_date,
      'screen_limit' in b ? (b.screen_limit === '' || b.screen_limit == null ? null : b.screen_limit) : c.screen_limit,
      b.whatsapp ?? null,
      'message_header' in b ? (b.message_header || null) : c.message_header,
      'due_date' in b ? 1 : 0,
      c.id);
  const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id);
  updated.device_count = deviceCount(c.id);
  res.json(updated);
});

// Atalho de renovação: soma dias a partir do vencimento atual (se ainda for
// futuro) ou de hoje (se já venceu), e reativa a empresa automaticamente —
// renovar o pagamento não deveria exigir um segundo clique pra "desuspender".
app.post('/api/companies/:id/renew', auth, superAdminOnly, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Empresa não encontrada' });
  const days = clamp(req.body?.days, 1, 3650, 30);
  const today = new Date().toISOString().slice(0, 10);
  const base = (c.due_date && c.due_date > today) ? c.due_date : today;
  const next = new Date(base + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + days);
  db.prepare('UPDATE companies SET due_date = ?, active = 1, last_reminder_stage = NULL WHERE id = ?')
    .run(next.toISOString().slice(0, 10), c.id);
  const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id);
  updated.device_count = deviceCount(c.id);
  res.json(updated);
});

// Disparo manual do aviso de WhatsApp — não espera o cron das 9h, e ignora o
// guard de "já mandei esse estágio" de propósito (é uma ação explícita).
// Sem due_date cadastrado, ainda assim manda o topo personalizado (se houver)
// com uma linha genérica no lugar do aviso de vencimento.
app.post('/api/companies/:id/notify', auth, superAdminOnly, async (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Empresa não encontrada' });
  if (!c.whatsapp) return res.status(400).json({ error: 'Cadastre o WhatsApp da empresa antes de disparar um aviso' });
  const stage = dueStage(c) || 'pre_due'; // fora da janela de 3 dias mas com due_date: ainda assim avisa
  const text = buildDueMessage(c, stage);
  const result = await sendWhatsApp(c.whatsapp, text);
  if (stage !== 'none') db.prepare('UPDATE companies SET last_reminder_stage = ? WHERE id = ?').run(stage, c.id);
  db.prepare('INSERT INTO notifications_log (id, company_id, channel, kind, success, detail) VALUES (?,?,?,?,?,?)')
    .run(uuid(), c.id, 'whatsapp', 'manual_' + stage, result.ok ? 1 : 0, result.error);
  res.json({ ok: result.ok, error: result.error, message: text });
});

// Dados da própria empresa (qualquer papel autenticado) — usado pelo painel
// pra mostrar um aviso de vencimento pro admin do cliente, sem precisar ser
// super_admin.
app.get('/api/company', auth, (req, res) => {
  if (!req.user.company_id) return res.json(null);
  const c = db.prepare('SELECT id, name, active, due_date, screen_limit FROM companies WHERE id = ?').get(req.user.company_id);
  if (!c) return res.json(null);
  c.device_count = deviceCount(c.id);
  res.json(c);
});

// ---------- Anunciantes (clientes de anúncio de CADA empresa — ex.: as lojas
// que pagam a um shopping para aparecer nas telas dele) ----------
// Mesmas faixas de dias usadas para a assinatura da empresa (ver dueStage mais
// abaixo), aplicadas ao vencimento do contrato do anunciante.
function advStage(a) {
  const d = daysUntil(a.due_date);
  return d > 3 ? null : d >= 1 ? 'pre_due' : d === 0 ? 'due' : 'overdue';
}
// Mensagens prontas para o botão de WhatsApp — o admin da empresa escolhe uma,
// edita se quiser, e só então dispara (POST /advertisers/:id/notify).
function serializeAdvertiser(a) {
  const d = daysUntil(a.due_date);
  const dueFmt = a.due_date.split('-').reverse().join('/');
  return {
    ...a, days_left: d, stage: advStage(a) || 'ok',
    templates: {
      pre_due: `Olá, ${a.name}! Seu anúncio no VitriniON vence em ${d} dia${d === 1 ? '' : 's'}, em ${dueFmt}. Para continuar em exibição, entre em contato para renovar.`,
      due: `Olá, ${a.name}! Seu anúncio vence hoje (${dueFmt}). Renove para manter seu anúncio em exibição.`,
      overdue: `Olá, ${a.name}! Seu anúncio está vencido desde ${dueFmt} e pode sair da programação. Entre em contato para renovar.`
    }
  };
}

app.get('/api/advertisers', auth, adminOnly, (req, res) => {
  const cid = companyCtx(req);
  const rows = cid
    ? db.prepare('SELECT * FROM advertisers WHERE company_id = ? ORDER BY due_date').all(cid)
    : db.prepare(`SELECT a.*, c.name AS company_name FROM advertisers a
                  JOIN companies c ON c.id = a.company_id ORDER BY a.due_date`).all();
  res.json(rows.map(serializeAdvertiser));
});

// Painel de rendimentos: receita mensal recorrente (valor normalizado pelo prazo
// de cada anunciante), fechamentos do mês corrente e uma grade de 8 semanas para
// visualizar quando os próximos vencimentos (= possíveis renovações) caem.
app.get('/api/advertisers/stats', auth, adminOnly, (req, res) => {
  const cid = companyCtx(req);
  const rows = cid
    ? db.prepare('SELECT * FROM advertisers WHERE company_id = ?').all(cid)
    : db.prepare('SELECT * FROM advertisers').all();
  const active = rows.filter(a => a.active);
  const mrr = active.reduce((s, a) => s + (a.value / Math.max(1, a.term_days / 30)), 0);

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const monthEndD = new Date(monthStart + 'T00:00:00Z'); monthEndD.setUTCMonth(monthEndD.getUTCMonth() + 1);
  const monthEnd = monthEndD.toISOString().slice(0, 10);
  const closingsMonth = active.filter(a => a.due_date >= monthStart && a.due_date < monthEnd);
  const dueSoon = active.filter(a => { const d = daysUntil(a.due_date); return d >= 0 && d <= 7; });
  const overdue = active.filter(a => daysUntil(a.due_date) < 0);

  // Semana começando na segunda-feira, para bater com o calendário comercial.
  function mondayOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day));
    return d;
  }
  const w0 = mondayOf(today);
  const weekly = [];
  for (let i = 0; i < 8; i++) {
    const ws = new Date(w0); ws.setUTCDate(ws.getUTCDate() + i * 7);
    const we = new Date(ws); we.setUTCDate(we.getUTCDate() + 6);
    const wsS = ws.toISOString().slice(0, 10), weS = we.toISOString().slice(0, 10);
    const inWeek = active.filter(a => a.due_date >= wsS && a.due_date <= weS);
    weekly.push({ start: wsS, end: weS, count: inWeek.length, value: inWeek.reduce((s, a) => s + a.value, 0) });
  }

  res.json({
    mrr, active_count: active.length, total_count: rows.length,
    closings_month: { count: closingsMonth.length, value: closingsMonth.reduce((s, a) => s + a.value, 0) },
    due_soon: dueSoon.length, overdue: overdue.length,
    weekly
  });
});

app.post('/api/advertisers', auth, adminOnly, (req, res) => {
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de cadastrar um anunciante' });
  const { name, value, term_days, start_date, whatsapp, contact, notes } = req.body || {};
  if (!name || !value) return res.status(400).json({ error: 'Nome e valor são obrigatórios' });
  const termD = clamp(term_days, 1, 3650, 30);
  const start = start_date || new Date().toISOString().slice(0, 10);
  const due = new Date(start + 'T00:00:00Z'); due.setUTCDate(due.getUTCDate() + termD);
  const id = uuid();
  db.prepare(`INSERT INTO advertisers (id, company_id, name, contact, whatsapp, value, term_days, start_date, due_date, notes)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, cid, name, contact || null, whatsapp || null, Number(value) || 0, termD, start,
         due.toISOString().slice(0, 10), notes || null);
  res.status(201).json(serializeAdvertiser(db.prepare('SELECT * FROM advertisers WHERE id = ?').get(id)));
});

app.put('/api/advertisers/:id', auth, adminOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM advertisers WHERE id = ?').get(req.params.id);
  if (!a || !ownedRow(req.user, a)) return res.status(404).json({ error: 'Anunciante não encontrado' });
  const b = req.body || {};
  db.prepare(`UPDATE advertisers SET
      name = COALESCE(?, name),
      contact = ?,
      whatsapp = COALESCE(?, whatsapp),
      value = COALESCE(?, value),
      term_days = COALESCE(?, term_days),
      due_date = COALESCE(?, due_date),
      active = COALESCE(?, active),
      notes = ?,
      last_reminder_stage = CASE WHEN ? THEN NULL ELSE last_reminder_stage END
      WHERE id = ?`)
    .run(
      b.name ?? null,
      'contact' in b ? (b.contact || null) : a.contact,
      b.whatsapp ?? null,
      b.value != null ? Number(b.value) : null,
      b.term_days != null ? clamp(b.term_days, 1, 3650, a.term_days) : null,
      'due_date' in b ? (b.due_date || a.due_date) : null,
      b.active === undefined ? null : (b.active ? 1 : 0),
      'notes' in b ? (b.notes || null) : a.notes,
      'due_date' in b ? 1 : 0,
      a.id);
  res.json(serializeAdvertiser(db.prepare('SELECT * FROM advertisers WHERE id = ?').get(a.id)));
});

// Atalho de renovação: soma dias (padrão = o próprio prazo do contrato) a partir
// do vencimento atual (se ainda for futuro) ou de hoje (se já venceu).
app.post('/api/advertisers/:id/renew', auth, adminOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM advertisers WHERE id = ?').get(req.params.id);
  if (!a || !ownedRow(req.user, a)) return res.status(404).json({ error: 'Anunciante não encontrado' });
  const days = clamp(req.body?.days, 1, 3650, a.term_days);
  const today = new Date().toISOString().slice(0, 10);
  const base = a.due_date > today ? a.due_date : today;
  const next = new Date(base + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + days);
  db.prepare('UPDATE advertisers SET due_date = ?, active = 1, last_reminder_stage = NULL WHERE id = ?')
    .run(next.toISOString().slice(0, 10), a.id);
  res.json(serializeAdvertiser(db.prepare('SELECT * FROM advertisers WHERE id = ?').get(a.id)));
});

// Disparo do WhatsApp a partir de um modelo pronto (o texto final já vem
// composto do painel — o admin pode editar antes de enviar).
app.post('/api/advertisers/:id/notify', auth, adminOnly, async (req, res) => {
  const a = db.prepare('SELECT * FROM advertisers WHERE id = ?').get(req.params.id);
  if (!a || !ownedRow(req.user, a)) return res.status(404).json({ error: 'Anunciante não encontrado' });
  if (!a.whatsapp) return res.status(400).json({ error: 'Cadastre o WhatsApp do anunciante antes de enviar' });
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensagem vazia' });
  const result = await sendWhatsApp(a.whatsapp, text);
  const stage = advStage(a);
  if (stage) db.prepare('UPDATE advertisers SET last_reminder_stage = ? WHERE id = ?').run(stage, a.id);
  db.prepare(`INSERT INTO notifications_log (id, company_id, advertiser_id, channel, kind, success, detail)
              VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), a.company_id, a.id, 'whatsapp', 'manual_advertiser', result.ok ? 1 : 0, result.error);
  res.json({ ok: result.ok, error: result.error });
});

app.delete('/api/advertisers/:id', auth, adminOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM advertisers WHERE id = ?').get(req.params.id);
  if (!a || !ownedRow(req.user, a)) return res.status(404).json({ error: 'Anunciante não encontrado' });
  db.prepare('DELETE FROM advertisers WHERE id = ?').run(a.id);
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
  const cid = companyCtx(req);
  res.json(cid
    ? db.prepare('SELECT * FROM media WHERE company_id = ? ORDER BY uploaded_at DESC').all(cid)
    : db.prepare('SELECT * FROM media ORDER BY uploaded_at DESC').all());
});

// SHA-256 em streaming: um vídeo de 1 GB não pode passar pela memória inteiro
function fileSha256(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

app.post('/api/media/upload', auth, canWrite, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo ausente' });
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de enviar mídia' });
  const isVideo = /\.(mp4|mkv|webm)$/i.test(req.file.filename);
  const checksum = await fileSha256(req.file.path);
  const id = uuid();
  db.prepare(`INSERT INTO media (id, filename, file_path, file_type, duration_seconds, file_size, checksum, company_id)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.file.originalname, `/media/${req.file.filename}`,
         isVideo ? 'video' : 'image', isVideo ? null : 10, req.file.size, checksum, cid);
  res.status(201).json(db.prepare('SELECT * FROM media WHERE id = ?').get(id));
});

app.delete('/api/media/:id', auth, canWrite, (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!m || !ownedRow(req.user, m)) return res.status(404).json({ error: 'Não encontrado' });
  const abs = path.join(MEDIA_DIR, path.basename(m.file_path));
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Playlists ----------
app.get('/api/playlists', auth, (req, res) => {
  const cid = companyCtx(req);
  const lists = cid
    ? db.prepare('SELECT * FROM playlists WHERE company_id = ? ORDER BY created_at DESC').all(cid)
    : db.prepare('SELECT * FROM playlists ORDER BY created_at DESC').all();
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
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de criar a playlist' });
  const id = uuid();
  db.prepare('INSERT INTO playlists (id, name, description, company_id) VALUES (?,?,?,?)')
    .run(id, name, description || null, cid);
  res.status(201).json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id));
});

// Substitui todos os itens da playlist (ordem enviada = ordem final)
app.put('/api/playlists/:id/items', auth, canWrite, (req, res) => {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!p || !ownedRow(req.user, p)) return res.status(404).json({ error: 'Playlist não encontrada' });
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
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!p || !ownedRow(req.user, p)) return res.status(404).json({ error: 'Playlist não encontrada' });
  db.prepare('UPDATE devices SET playlist_id = NULL WHERE playlist_id = ?').run(req.params.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Atribuir playlist a dispositivo ou grupo
app.post('/api/playlists/:id/assign', auth, canWrite, (req, res) => {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!p || !ownedRow(req.user, p)) return res.status(404).json({ error: 'Playlist não encontrada' });
  const { device_id, group_id } = req.body || {};
  if (!device_id && !group_id) return res.status(400).json({ error: 'Informe device_id ou group_id' });
  if (device_id) {
    const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
    if (!dev || !ownedDevice(req.user, dev)) return res.status(404).json({ error: 'Tela não encontrada' });
  }
  if (group_id) {
    const grp = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(group_id);
    if (!grp || !ownedRow(req.user, grp)) return res.status(404).json({ error: 'Grupo não encontrado' });
  }
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
app.get('/api/groups', auth, (req, res) => {
  const cid = companyCtx(req);
  res.json(cid
    ? db.prepare('SELECT * FROM device_groups WHERE company_id = ? ORDER BY name').all(cid)
    : db.prepare('SELECT * FROM device_groups ORDER BY name').all());
});

app.post('/api/groups', auth, adminOnly, (req, res) => {
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de criar o grupo' });
  const id = uuid();
  db.prepare('INSERT INTO device_groups (id, name, description, company_id) VALUES (?,?,?,?)')
    .run(id, req.body.name, req.body.description || null, cid);
  res.status(201).json(db.prepare('SELECT * FROM device_groups WHERE id = ?').get(id));
});

app.delete('/api/groups/:id', auth, adminOnly, (req, res) => {
  const g = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(req.params.id);
  if (!g || !ownedRow(req.user, g)) return res.status(404).json({ error: 'Grupo não encontrado' });
  db.prepare('DELETE FROM device_groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Dispositivos ----------
app.get('/api/devices', auth, (req, res) => {
  const cutoff = new Date(Date.now() - 90_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`UPDATE devices SET status='offline' WHERE last_heartbeat IS NULL OR last_heartbeat < ?`).run(cutoff);
  const cid = companyCtx(req);
  const baseSql = `
    SELECT d.*, g.name AS group_name, p.name AS playlist_name,
           s.city AS sidebar_city, s.lat AS sidebar_lat, s.lon AS sidebar_lon
    FROM devices d
    LEFT JOIN device_groups g ON g.id = d.group_id
    LEFT JOIN playlists p ON p.id = d.playlist_id
    LEFT JOIN sidebars s ON s.id = d.sidebar_id`;
  // Telas da própria empresa + pendentes de qualquer empresa (pool de aprovação
  // — ver nota de arquitetura no README sobre o vínculo tela↔empresa).
  const devices = cid
    ? db.prepare(`${baseSql} WHERE d.company_id = ? OR (d.company_id IS NULL AND d.approved = 0) ORDER BY d.name`).all(cid)
    : db.prepare(`${baseSql} ORDER BY d.name`).all();

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
      // usa só o cache (a listagem nunca espera rede); se frio, aquece em
      // segundo plano — o próximo refresh do painel (15 s) já mostra
      const c = weatherCache.get(`${d.sidebar_lat.toFixed(3)},${d.sidebar_lon.toFixed(3)}`);
      if (c) d.sidebar_temp = c.data.temp;
      else getWeather(d.sidebar_lat, d.sidebar_lon).catch(() => {});
    }
    // Layout efetivo (para o espelho no console): próprio > herdado do grupo > legado
    const L = pickLayout(d);
    d.layout_name = L ? L.name : null;
    d.layout_inherited = !d.layout_id && !!L; // veio do grupo, não da própria tela
    d.eff_sidebar_width = L ? L.sidebar_width : (d.sidebar_width || 22);
    d.eff_ticker_height = L ? L.ticker_height : (d.ticker_height || 12);
    d.eff_sidebar_bg_mode = L ? L.sidebar_bg_mode : 'auto';
    d.eff_sidebar_bg_color = L ? L.sidebar_bg_color : null;
    d.eff_sidebar_bg_image = L ? L.sidebar_bg_image : null;
    d.eff_ticker_bg_mode = L ? L.ticker_bg_mode : 'auto';
    d.eff_ticker_bg_color = L ? L.ticker_bg_color : null;
    d.eff_ticker_bg_image = L ? L.ticker_bg_image : null;
    d.orientation = resolveOrientation(L, d.resolution);
  }
  res.json(devices);
});

app.put('/api/devices/:id', auth, canWrite, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d || !ownedDevice(req.user, d)) return res.status(404).json({ error: 'Tela não encontrada' });
  // Campo presente no body é autoritativo (null/'' limpa) — COALESCE impediria
  // remover uma tela de um grupo ou apagar o local.
  const b = req.body || {};
  const sets = [], vals = [];
  if ('name' in b && (b.name || '').trim()) { sets.push('name = ?'); vals.push(b.name.trim()); }
  if ('location' in b) { sets.push('location = ?'); vals.push((b.location || '').trim() || null); }
  if ('group_id' in b) {
    if (b.group_id) {
      const g = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(b.group_id);
      if (!g || !ownedRow(req.user, g)) return res.status(400).json({ error: 'Grupo inválido' });
    }
    sets.push('group_id = ?'); vals.push(b.group_id || null);
  }
  if ('approved' in b) {
    const turningOn = !!b.approved && !d.approved; // 0->1: é aqui que o limite de telas conta
    let cid = d.company_id;
    if (b.approved && !d.company_id) {
      // Tela ainda não pertence a ninguém: quem aprova reivindica p/ sua empresa.
      cid = companyCtx(req);
      if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa para aprovar esta tela' });
    }
    if (turningOn && cid) {
      const company = db.prepare('SELECT screen_limit FROM companies WHERE id = ?').get(cid);
      if (company?.screen_limit != null && deviceCount(cid) >= company.screen_limit) {
        return res.status(400).json({ error: `Limite de ${company.screen_limit} telas atingido para esta empresa.` });
      }
    }
    sets.push('approved = ?'); vals.push(b.approved ? 1 : 0);
    if (b.approved && !d.company_id) { sets.push('company_id = ?'); vals.push(cid); }
  }
  if ('screen_size' in b) {
    sets.push('screen_size = ?');
    vals.push(b.screen_size === '' || b.screen_size == null ? null : clamp(b.screen_size, 5, 200, null));
  }
  if (sets.length) db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals, d.id);
  res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id));
});

app.delete('/api/devices/:id', auth, adminOnly, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d || !ownedDevice(req.user, d)) return res.status(404).json({ error: 'Tela não encontrada' });
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/devices/:id/command', auth, canWrite, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d || !ownedDevice(req.user, d)) return res.status(404).json({ error: 'Tela não encontrada' });
  const sent = sendToDevice(req.params.id, { type: 'command', command: req.body.command });
  res.json({ ok: sent, delivered: sent });
});

// ---------- API do Player (sem JWT; autentica por device_key) ----------
const registerLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas de registro. Aguarde um minuto.' }
});
// Chave por device_key (não IP): várias telas reais compartilham IP na mesma loja.
const deviceKeyLimiter = rateLimit({
  windowMs: 30 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.query.device_key || (req.body && req.body.device_key) || ipKeyGenerator(req.ip),
  message: { error: 'Muitas requisições deste dispositivo.' }
});

app.post('/api/devices/register', registerLimiter, (req, res) => {
  const { device_key, device_name, resolution, os_version, client_version, platform } = req.body || {};
  if (!device_key) return res.status(400).json({ error: 'device_key obrigatório' });
  // plataforma é declarada pelo próprio agente (não inferida do user-agent) — 'windows' | 'android'
  const plat = ['windows', 'android'].includes(platform) ? platform : null;
  let d = db.prepare('SELECT * FROM devices WHERE device_key = ?').get(device_key);
  if (!d) {
    const id = uuid();
    // company_id fica NULL até um admin aprovar — ver ownedDevice()/pool de aprovação.
    db.prepare(`INSERT INTO devices (id, name, device_key, resolution, os_version, client_version, platform, status)
                VALUES (?,?,?,?,?,?,?, 'online')`)
      .run(id, device_name || 'Novo dispositivo', device_key, resolution || null, os_version || null, client_version || null, plat);
    d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  } else {
    db.prepare(`UPDATE devices SET resolution = COALESCE(?, resolution),
                os_version = COALESCE(?, os_version), client_version = COALESCE(?, client_version),
                platform = COALESCE(?, platform)
                WHERE id = ?`).run(resolution, os_version, client_version, plat, d.id);
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

// Telas que o usuário pode alterar (empresa própria + grupo, se for editor)
function filterAllowedDevices(user, ids) {
  // descarta ids inexistentes/de outra empresa (evita violação de FK e vazamento
  // entre tenants) e, para editores, restringe também aos grupos permitidos
  const existing = db.prepare('SELECT id, company_id, group_id FROM devices').all();
  const byId = new Map(existing.map(d => [d.id, d]));
  ids = ids.filter(id => byId.has(id) && ownedDevice(user, byId.get(id)));
  const allowed = allowedGroups(user);
  if (!allowed) return ids;
  if (!allowed.length) return [];
  return ids.filter(id => allowed.includes(byId.get(id).group_id));
}
function canEditDevice(user, device) {
  if (!ownedDevice(user, device)) return false;
  const allowed = allowedGroups(user);
  return !allowed || (device.group_id && allowed.includes(device.group_id));
}

// ---------- Faixas de rodapé (avisos) ----------
app.get('/api/tickers', auth, (req, res) => {
  const cid = companyCtx(req);
  const list = cid
    ? db.prepare('SELECT * FROM tickers WHERE company_id = ? ORDER BY name').all(cid)
    : db.prepare('SELECT * FROM tickers ORDER BY name').all();
  for (const t of list)
    t.device_ids = db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?')
      .all(t.id).map(r => r.device_id);
  res.json(list);
});

app.post('/api/tickers', auth, canWrite, (req, res) => {
  const { name, text } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Dê um nome à faixa' });
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de criar a faixa' });
  const id = uuid();
  db.prepare('INSERT INTO tickers (id, name, text, company_id) VALUES (?,?,?,?)').run(id, name, text || '', cid);
  res.status(201).json(db.prepare('SELECT * FROM tickers WHERE id = ?').get(id));
});

app.put('/api/tickers/:id', auth, canWrite, (req, res) => {
  const t = db.prepare('SELECT * FROM tickers WHERE id = ?').get(req.params.id);
  if (!t || !ownedRow(req.user, t)) return res.status(404).json({ error: 'Faixa não encontrada' });
  const { name, text } = req.body || {};
  db.prepare('UPDATE tickers SET name = COALESCE(?, name), text = COALESCE(?, text) WHERE id = ?')
    .run(name ?? null, text ?? null, t.id);
  db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?').all(t.id)
    .forEach(r => notifyDevice(r.device_id));
  res.json({ ok: true });
});

app.delete('/api/tickers/:id', auth, canWrite, (req, res) => {
  const t = db.prepare('SELECT * FROM tickers WHERE id = ?').get(req.params.id);
  if (!t || !ownedRow(req.user, t)) return res.status(404).json({ error: 'Faixa não encontrada' });
  const devs = db.prepare('SELECT device_id FROM device_tickers WHERE ticker_id = ?').all(req.params.id);
  db.prepare('DELETE FROM tickers WHERE id = ?').run(req.params.id);
  devs.forEach(r => notifyDevice(r.device_id));
  res.json({ ok: true });
});

// Atribuir a faixa a telas: uma, várias ou todas (envie a lista de ids)
app.put('/api/tickers/:id/devices', auth, canWrite, (req, res) => {
  const t = db.prepare('SELECT * FROM tickers WHERE id = ?').get(req.params.id);
  if (!t || !ownedRow(req.user, t)) return res.status(404).json({ error: 'Faixa não encontrada' });
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
  const cid = companyCtx(req);
  const list = cid
    ? db.prepare('SELECT * FROM sidebars WHERE company_id = ? ORDER BY name').all(cid)
    : db.prepare('SELECT * FROM sidebars ORDER BY name').all();
  for (const s of list)
    s.device_ids = db.prepare('SELECT id FROM devices WHERE sidebar_id = ?').all(s.id).map(r => r.id);
  res.json(list);
});

app.post('/api/sidebars', auth, canWrite, (req, res) => {
  const { name, city, postal_code, lat, lon, show_tomorrow } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Dê um nome ao perfil' });
  if (lat == null || lon == null) return res.status(400).json({ error: 'Escolha a cidade ou informe o CEP' });
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de criar o perfil' });
  const id = uuid();
  db.prepare(`INSERT INTO sidebars (id, name, city, postal_code, lat, lon, show_tomorrow, company_id)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, city || null, postal_code || null, lat, lon, show_tomorrow === false ? 0 : 1, cid);
  res.status(201).json(db.prepare('SELECT * FROM sidebars WHERE id = ?').get(id));
});

app.put('/api/sidebars/:id', auth, canWrite, (req, res) => {
  const s = db.prepare('SELECT * FROM sidebars WHERE id = ?').get(req.params.id);
  if (!s || !ownedRow(req.user, s)) return res.status(404).json({ error: 'Perfil não encontrado' });
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
  const s = db.prepare('SELECT * FROM sidebars WHERE id = ?').get(req.params.id);
  if (!s || !ownedRow(req.user, s)) return res.status(404).json({ error: 'Perfil não encontrado' });
  const devs = db.prepare('SELECT id FROM devices WHERE sidebar_id = ?').all(req.params.id);
  db.prepare('DELETE FROM sidebars WHERE id = ?').run(req.params.id);
  devs.forEach(r => notifyDevice(r.id));
  res.json({ ok: true });
});

// Atribuir o perfil de clima a telas (uma, várias ou todas)
app.put('/api/sidebars/:id/devices', auth, canWrite, (req, res) => {
  const s = db.prepare('SELECT * FROM sidebars WHERE id = ?').get(req.params.id);
  if (!s || !ownedRow(req.user, s)) return res.status(404).json({ error: 'Perfil não encontrado' });
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

// Layout da tela: perfil de clima, faixas de rodapé, perfil de LAYOUT (ou tamanhos avulsos)
app.put('/api/devices/:id/layout', auth, canWrite, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Tela não encontrada' });
  if (!canEditDevice(req.user, d))
    return res.status(403).json({ error: 'Você não tem permissão para editar esta tela' });
  const b = req.body || {};
  if (b.sidebar_id) {
    const s = db.prepare('SELECT * FROM sidebars WHERE id = ?').get(b.sidebar_id);
    if (!s || !ownedRow(req.user, s)) return res.status(400).json({ error: 'Perfil de clima inválido' });
  }
  if (b.layout_id) {
    const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(b.layout_id);
    if (!L || !ownedRow(req.user, L)) return res.status(400).json({ error: 'Perfil de layout inválido' });
  }
  db.prepare(`UPDATE devices SET sidebar_id = ?, layout_id = ?, sidebar_width = ?, ticker_height = ? WHERE id = ?`)
    .run(b.sidebar_id || null, b.layout_id || null,
         clamp(b.sidebar_width, 10, 45, d.sidebar_width || 22),
         clamp(b.ticker_height, 6, 30, d.ticker_height || 12), d.id);
  if (Array.isArray(b.ticker_ids)) {
    const validTickers = b.ticker_ids.filter(tid => {
      const t = db.prepare('SELECT * FROM tickers WHERE id = ?').get(tid);
      return t && ownedRow(req.user, t);
    });
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM device_tickers WHERE device_id = ?').run(d.id);
      const ins = db.prepare('INSERT OR IGNORE INTO device_tickers (device_id, ticker_id) VALUES (?,?)');
      validTickers.forEach(tid => ins.run(d.id, tid));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  notifyDevice(d.id);
  res.json({ ok: true });
});

// ---------- Perfis de LAYOUT (tamanho + fundo) ----------
app.get('/api/layouts', auth, (req, res) => {
  const cid = companyCtx(req);
  const list = cid
    ? db.prepare('SELECT * FROM layouts WHERE company_id = ? ORDER BY name').all(cid)
    : db.prepare('SELECT * FROM layouts ORDER BY name').all();
  for (const L of list) {
    L.device_ids = db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(L.id).map(r => r.id);
    L.group_ids = db.prepare('SELECT id FROM device_groups WHERE layout_id = ?').all(L.id).map(r => r.id);
  }
  res.json(list);
});

app.post('/api/layouts', auth, canWrite, (req, res) => {
  const { name, sidebar_width, ticker_height, orientation } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Dê um nome ao perfil de layout' });
  const cid = companyCtx(req);
  if (!cid) return res.status(400).json({ error: 'Selecione a empresa ativa antes de criar o perfil' });
  const id = uuid();
  db.prepare(`INSERT INTO layouts (id, name, sidebar_width, ticker_height, orientation, company_id) VALUES (?,?,?,?,?,?)`)
    .run(id, name, clamp(sidebar_width, 10, 45, 22), clamp(ticker_height, 6, 30, 12),
         ['auto', 'landscape', 'portrait'].includes(orientation) ? orientation : 'auto', cid);
  res.status(201).json(db.prepare('SELECT * FROM layouts WHERE id = ?').get(id));
});

app.put('/api/layouts/:id', auth, canWrite, (req, res) => {
  const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!L || !ownedRow(req.user, L)) return res.status(404).json({ error: 'Perfil de layout não encontrado' });
  const b = req.body || {};
  const sideMode = ['auto', 'color', 'image'].includes(b.sidebar_bg_mode) ? b.sidebar_bg_mode : L.sidebar_bg_mode;
  const tickMode = ['auto', 'color', 'image'].includes(b.ticker_bg_mode) ? b.ticker_bg_mode : L.ticker_bg_mode;
  db.prepare(`UPDATE layouts SET
      name = ?, sidebar_width = ?, ticker_height = ?, orientation = ?,
      sidebar_bg_mode = ?, sidebar_bg_color = ?,
      ticker_bg_mode = ?, ticker_bg_color = ?
      WHERE id = ?`)
    .run(
      b.name && b.name.trim() ? b.name.trim() : L.name,
      clamp(b.sidebar_width, 10, 45, L.sidebar_width),
      clamp(b.ticker_height, 6, 30, L.ticker_height),
      ['auto', 'landscape', 'portrait'].includes(b.orientation) ? b.orientation : L.orientation,
      sideMode, sideMode === 'color' ? (b.sidebar_bg_color || L.sidebar_bg_color) : (sideMode === 'auto' ? null : L.sidebar_bg_color),
      tickMode, tickMode === 'color' ? (b.ticker_bg_color || L.ticker_bg_color) : (tickMode === 'auto' ? null : L.ticker_bg_color),
      L.id);
  notifyLayoutDevices(L.id);
  res.json(db.prepare('SELECT * FROM layouts WHERE id = ?').get(L.id));
});

app.delete('/api/layouts/:id', auth, canWrite, (req, res) => {
  const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!L || !ownedRow(req.user, L)) return res.status(404).json({ error: 'Perfil de layout não encontrado' });
  const devs = db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(req.params.id);
  const inherited = db.prepare(`SELECT d.id FROM devices d JOIN device_groups g ON g.id = d.group_id
                                 WHERE g.layout_id = ?`).all(req.params.id);
  db.prepare('DELETE FROM layouts WHERE id = ?').run(req.params.id);
  [...devs, ...inherited].forEach(r => notifyDevice(r.id));
  res.json({ ok: true });
});

// Envio do fundo (JPG/PNG/WEBP) para a barra lateral ou o rodapé deste perfil
const bgUpload = multer({
  storage: multer.diskStorage({
    destination: BG_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB — imagem de fundo, não vídeo
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Use JPG, PNG ou WEBP'), ok);
  }
});

app.post('/api/layouts/:id/background', auth, canWrite, bgUpload.single('file'), async (req, res) => {
  const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!L || !ownedRow(req.user, L)) return res.status(404).json({ error: 'Perfil de layout não encontrado' });
  if (!req.file) return res.status(400).json({ error: 'Arquivo ausente' });
  const side = req.body.side === 'ticker' ? 'ticker' : 'sidebar';
  const checksum = await fileSha256(req.file.path);
  const url = `/backgrounds/${req.file.filename}`;
  db.prepare(`UPDATE layouts SET ${side}_bg_mode = 'image', ${side}_bg_image = ?,
              ${side}_bg_checksum = ?, ${side}_bg_color = NULL WHERE id = ?`)
    .run(url, checksum, L.id);
  notifyLayoutDevices(L.id);
  res.json(db.prepare('SELECT * FROM layouts WHERE id = ?').get(L.id));
});

// Atribuir o perfil de layout a telas específicas (override direto — vence o do grupo)
app.put('/api/layouts/:id/devices', auth, canWrite, (req, res) => {
  const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!L || !ownedRow(req.user, L)) return res.status(404).json({ error: 'Perfil de layout não encontrado' });
  const wanted = filterAllowedDevices(req.user, req.body.device_ids || []);
  const before = db.prepare('SELECT id FROM devices WHERE layout_id = ?').all(L.id).map(r => r.id);
  const editable = filterAllowedDevices(req.user, before);
  db.exec('BEGIN');
  try {
    const clear = db.prepare('UPDATE devices SET layout_id = NULL WHERE id = ?');
    editable.forEach(id => clear.run(id));
    const set = db.prepare('UPDATE devices SET layout_id = ? WHERE id = ?');
    wanted.forEach(id => set.run(L.id, id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  new Set([...before, ...wanted]).forEach(id => notifyDevice(id));
  res.json({ ok: true, count: wanted.length });
});

// Atribuir o perfil de layout como padrão de um ou vários GRUPOS inteiros
app.put('/api/layouts/:id/groups', auth, adminOnly, (req, res) => {
  const L = db.prepare('SELECT * FROM layouts WHERE id = ?').get(req.params.id);
  if (!L || !ownedRow(req.user, L)) return res.status(404).json({ error: 'Perfil de layout não encontrado' });
  const cid = companyCtx(req);
  const allIds = new Set((cid
    ? db.prepare('SELECT id FROM device_groups WHERE company_id = ?').all(cid)
    : db.prepare('SELECT id FROM device_groups').all()).map(r => r.id));
  const wanted = (req.body.group_ids || []).filter(id => allIds.has(id));
  const before = db.prepare('SELECT id FROM device_groups WHERE layout_id = ?').all(L.id).map(r => r.id);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE device_groups SET layout_id = NULL WHERE layout_id = ?').run(L.id);
    const set = db.prepare('UPDATE device_groups SET layout_id = ? WHERE id = ?');
    wanted.forEach(id => set.run(L.id, id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const affected = new Set([...before, ...wanted]);
  if (affected.size) {
    const ph = [...affected].map(() => '?').join(',');
    db.prepare(`SELECT id FROM devices WHERE group_id IN (${ph}) AND layout_id IS NULL`)
      .all(...affected).forEach(r => notifyDevice(r.id));
  }
  res.json({ ok: true, count: wanted.length });
});

async function buildLayout(d) {
  const L = pickLayout(d);
  const sidebarWidth = L ? L.sidebar_width : (d.sidebar_width || 22);
  const tickerHeight = L ? L.ticker_height : (d.ticker_height || 12);
  const layout = {
    orientation: resolveOrientation(L, d.resolution),
    weather: {
      enabled: false, width: sidebarWidth, city: '',
      bgMode: L ? L.sidebar_bg_mode : 'auto', bgColor: (L && L.sidebar_bg_color) || null,
      bgImage: (L && L.sidebar_bg_image) || null, bgChecksum: (L && L.sidebar_bg_checksum) || null
    },
    ticker: {
      enabled: false, height: tickerHeight, text: '',
      bgMode: L ? L.ticker_bg_mode : 'auto', bgColor: (L && L.ticker_bg_color) || null,
      bgImage: (L && L.ticker_bg_image) || null, bgChecksum: (L && L.ticker_bg_checksum) || null
    }
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

app.get('/api/player/manifest', deviceKeyLimiter, async (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE device_key = ?').get(req.query.device_key);
  if (!d) return res.status(404).json({ error: 'Dispositivo não registrado' });
  res.json(await buildManifest(d));
});

app.post('/api/player/heartbeat', deviceKeyLimiter, (req, res) => {
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

// ---------- Aviso de vencimento por WhatsApp ----------
// Faixas de dias (não um dia exato): se o servidor ficar fora do ar no dia
// certo, o próximo boot ainda calcula o estágio correto a partir da data,
// em vez de perder o aviso. last_reminder_stage evita reenviar o mesmo aviso
// automático — o disparo manual (POST /companies/:id/notify) ignora esse guard
// de propósito, porque é uma ação explícita do super_admin.
function dueStage(c) {
  if (!c.due_date) return 'none';
  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = Math.round((new Date(c.due_date) - new Date(today)) / 86400000);
  return daysLeft > 3 ? null : daysLeft >= 1 ? 'pre_due' : daysLeft === 0 ? 'due' : 'overdue';
}
// message_header é o "topo" que o super_admin escreve por empresa (ex.: saudação
// com o nome do contato, ou uma linha de marca) — vem sempre antes do aviso
// automático de vencimento, nunca substitui a parte que informa a data.
function buildDueMessage(c, stage) {
  const header = (c.message_header || '').trim();
  const bodies = {
    pre_due: `A assinatura do VitriniON da ${c.name} vence em breve (${c.due_date}). Entre em contato para renovar.`,
    due: `A assinatura do VitriniON da ${c.name} vence hoje (${c.due_date}). Renove para manter o acesso.`,
    overdue: `A assinatura do VitriniON da ${c.name} está vencida desde ${c.due_date}. O acesso ao painel foi bloqueado.`,
    none: `Este é um aviso sobre a assinatura do VitriniON da ${c.name}.`
  };
  const body = bodies[stage] || bodies.none;
  return header ? `${header}\n\n${body}` : `Olá! ${body}`;
}

async function checkDueDates() {
  const companies = db.prepare(`SELECT * FROM companies WHERE due_date IS NOT NULL AND active = 1`).all();
  for (const c of companies) {
    const stage = dueStage(c);
    if (!stage || stage === 'none' || stage === c.last_reminder_stage) continue;
    const result = c.whatsapp
      ? await sendWhatsApp(c.whatsapp, buildDueMessage(c, stage))
      : { ok: false, error: 'sem_whatsapp_cadastrado' };
    db.prepare('UPDATE companies SET last_reminder_stage = ? WHERE id = ?').run(stage, c.id);
    db.prepare('INSERT INTO notifications_log (id, company_id, channel, kind, success, detail) VALUES (?,?,?,?,?,?)')
      .run(uuid(), c.id, 'whatsapp', stage, result.ok ? 1 : 0, result.error);
  }
}
cron.schedule('0 9 * * *', checkDueDates); // todo dia às 9h
if (process.env.CHECK_DUE_ON_BOOT) checkDueDates().catch(e => console.error('[whatsapp] checkDueDates:', e.message));

server.listen(PORT, () =>
  console.log(`VitriniON server rodando em http://0.0.0.0:${PORT}`));
