// Cria o usuário administrador inicial. Uso: npm run seed [email] [senha]
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('./db');

const email = process.argv[2] || 'admin@6signage.local';
const password = process.argv[3] || 'admin123';

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?')
    .run(bcrypt.hashSync(password, 10), email);
  console.log(`Senha atualizada para ${email}`);
} else {
  db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?,?,?,?)')
    .run(uuid(), email, bcrypt.hashSync(password, 10), 'admin');
  console.log(`Usuário admin criado: ${email} / ${password}`);
}
