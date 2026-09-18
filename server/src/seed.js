// Cria o usuário administrador inicial.
// Uso: npm run seed [email] [senha]              -> admin da "Empresa Padrão"
//      npm run seed -- --super [email] [senha]    -> super_admin (sem empresa, vê todas)
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('./db');

const args = process.argv.slice(2);
const isSuper = args.includes('--super');
const rest = args.filter(a => a !== '--super');
const email = rest[0] || (isSuper ? 'super@vitrinion.local' : 'admin@vitrinion.local');
const password = rest[1] || 'admin123';
const role = isSuper ? 'super_admin' : 'admin';
const companyId = isSuper ? null : 'default-company';

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, role = ?, company_id = ? WHERE email = ?')
    .run(bcrypt.hashSync(password, 10), role, companyId, email);
  console.log(`Senha/papel atualizados para ${email} (${role})`);
} else {
  db.prepare('INSERT INTO users (id, email, password_hash, role, company_id) VALUES (?,?,?,?,?)')
    .run(uuid(), email, bcrypt.hashSync(password, 10), role, companyId);
  console.log(`Usuário ${role} criado: ${email} / ${password}`);
}
