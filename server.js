const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// Clé de signature : variable d'environnement, sinon générée une fois et conservée
const keyFile = path.join(DATA, 'secret.key');
const SECRET = process.env.JWT_SECRET || (fs.existsSync(keyFile)
  ? fs.readFileSync(keyFile, 'utf8')
  : (() => { const k = crypto.randomBytes(48).toString('hex'); fs.writeFileSync(keyFile, k); return k; })());

const db = new Database(path.join(DATA, 'messagerie.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, recipient_id);
`);

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth ----------
const publicUser = u => ({ id: u.id, email: u.email, name: u.name });
const cookieOf = (req, n) => (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(c => c[0] === n)?.[1];
const setToken = (res, user) => res.setHeader('Set-Cookie',
  `token=${jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' })}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);

function auth(req, res, next) {
  try {
    const { id } = jwt.verify(cookieOf(req, 'token') || '', SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw 0;
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Connexion requise.' }); }
}

app.post('/api/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 40);
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  if (!name) return res.status(400).json({ error: 'Choisis un nom affiché.' });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail.' });
  const info = db.prepare('INSERT INTO users (email, name, password, created_at) VALUES (?,?,?,?)')
    .run(email, name, bcrypt.hashSync(password, 11), Date.now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  setToken(res, user); res.json(publicUser(user));
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password))
    return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
  setToken(res, user); res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.patch('/api/me', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ...publicUser(req.user), name });
});

// ---------- Messagerie ----------
app.get('/api/users', auth, (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  res.json(db.prepare(`SELECT id, name, email FROM users
    WHERE id != ? AND (lower(email) LIKE ? OR lower(name) LIKE ?) ORDER BY name LIMIT 20`).all(req.user.id, q, q));
});

app.get('/api/conversations', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, m.body, m.created_at, m.sender_id
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.sender_id = @me THEN m.recipient_id ELSE m.sender_id END
    WHERE m.id IN (
      SELECT MAX(id) FROM messages WHERE sender_id = @me OR recipient_id = @me
      GROUP BY CASE WHEN sender_id = @me THEN recipient_id ELSE sender_id END)
    ORDER BY m.id DESC`).all({ me: req.user.id }));
});

app.get('/api/messages/:peer', auth, (req, res) => {
  const me = req.user.id, peer = Number(req.params.peer);
  res.json(db.prepare(`SELECT * FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY id DESC LIMIT 200`).all(me, peer, peer, me).reverse());
});

// Temps réel (Server-Sent Events)
const streams = new Map();
app.get('/api/stream', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const set = streams.get(req.user.id) || new Set();
  set.add(res); streams.set(req.user.id, set);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); });
});
const push = (uid, msg) => streams.get(uid)?.forEach(r => r.write(`data: ${JSON.stringify(msg)}\n\n`));

app.post('/api/messages', auth, (req, res) => {
  const to = Number(req.body.to), body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'Message vide.' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(to)) return res.status(404).json({ error: 'Destinataire introuvable.' });
  const info = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, to, body, Date.now());
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  push(to, msg); if (to !== req.user.id) push(req.user.id, msg);
  res.json(msg);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Messagerie sur http://localhost:${PORT}`));

