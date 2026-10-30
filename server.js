const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATABASE_URL = process.env.DATABASE_URL;
const FUSO = process.env.AGENDA_FUSO || 'America/Sao_Paulo';

const DURACAO = 60;
const INTERVALO = 15;
const JANELAS = [['13:00', '20:00']];
const BLOCO = DURACAO + INTERVALO;
const DIAS_ATENDIMENTO = [1, 2, 3, 4, 5];

let consultar;

async function iniciarBanco() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
    });
    consultar = async (sql, params = []) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows, count: r.rowCount };
    };
    await consultar(`CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL,
      endereco TEXT,
      data TEXT NOT NULL,
      hora TEXT NOT NULL,
      observacao TEXT,
      status TEXT NOT NULL DEFAULT 'confirmado',
      criado_em TIMESTAMP DEFAULT NOW()
    )`);
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(__dirname, 'agenda.db'));
    consultar = async (sql, params = []) => {
      const stmt = db.prepare(sql.replace(/\$\d+/g, '?'));
      if (/^\s*select/i.test(sql) || /returning/i.test(sql)) {
        const rows = stmt.all(...params);
        return { rows, count: rows.length };
      }
      return { rows: [], count: Number(stmt.run(...params).changes) };
    };
    db.exec(`CREATE TABLE IF NOT EXISTS agendamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL,
      endereco TEXT,
      data TEXT NOT NULL,
      hora TEXT NOT NULL,
      observacao TEXT,
      status TEXT NOT NULL DEFAULT 'confirmado',
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const colunas = db.prepare('PRAGMA table_info(agendamentos)').all().map((c) => c.name);
    if (!colunas.includes('endereco')) db.exec('ALTER TABLE agendamentos ADD COLUMN endereco TEXT');
  }
  await consultar("CREATE UNIQUE INDEX IF NOT EXISTS ux_horario ON agendamentos(data, hora) WHERE status = 'confirmado'");
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function hoje() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: FUSO });
}

function agora() {
  return new Date().toLocaleTimeString('sv-SE', { timeZone: FUSO }).slice(0, 5);
}

function paraMin(h) {
  const [a, b] = h.split(':').map(Number);
  return a * 60 + b;
}

function paraHora(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function diaValido(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return false;
  const d = new Date(data + 'T00:00:00');
  if (isNaN(d)) return false;
  return DIAS_ATENDIMENTO.includes(d.getDay()) && data >= hoje();
}

function cabeNaJanela(m) {
  return JANELAS.some(([i, f]) => m >= paraMin(i) && m + DURACAO <= paraMin(f));
}

async function horariosLivres(data) {
  const r = await consultar("SELECT hora FROM agendamentos WHERE data = $1 AND status = 'confirmado'", [data]);
  const ocupados = r.rows.map((x) => paraMin(x.hora));
  const candidatos = new Set();
  JANELAS.forEach(([i, f]) => {
    for (let m = paraMin(i); m + DURACAO <= paraMin(f); m += 60) candidatos.add(m);
  });
  ocupados.forEach((s) => {
    candidatos.add(s + BLOCO);
    candidatos.add(s - BLOCO);
  });
  const agoraMin = paraMin(agora());
  return [...candidatos]
      .filter((m) => cabeNaJanela(m))
      .filter((m) => ocupados.every((s) => m >= s + BLOCO || s >= m + BLOCO))
      .filter((m) => data > hoje() || m > agoraMin)
      .sort((a, b) => a - b)
      .map(paraHora);
}

function senhaCorreta(s) {
  const a = Buffer.from(String(s || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const falhas = new Map();

function exigirAdmin(req, res, next) {
  const f = falhas.get(req.ip) || { n: 0, ate: 0 };
  const ativo = Date.now() < f.ate;
  if (ativo && f.n >= 10) {
    return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }
  if (!senhaCorreta(req.get('x-admin-password'))) {
    falhas.set(req.ip, { n: (ativo ? f.n : 0) + 1, ate: Date.now() + 15 * 60 * 1000 });
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  falhas.delete(req.ip);
  next();
}

app.get('/saude', (req, res) => res.send('ok'));

app.get('/api/horarios', rota(async (req, res) => {
  const { data } = req.query;
  if (!diaValido(data)) {
    return res.status(400).json({ erro: 'Escolha um dia útil a partir de hoje.' });
  }
  res.json({ data, horarios: await horariosLivres(data) });
}));

app.post('/api/agendamentos', rota(async (req, res) => {
  const { nome, telefone, endereco, data, hora, observacao } = req.body;
  if (!nome || !telefone || !endereco || !data || !hora) {
    return res.status(400).json({ erro: 'Preencha nome, telefone, endereço, data e horário.' });
  }
  if (!diaValido(data)) {
    return res.status(400).json({ erro: 'Escolha um dia útil a partir de hoje.' });
  }
  if (!(await horariosLivres(data)).includes(hora)) {
    return res.status(409).json({ erro: 'Esse horário não está mais disponível.' });
  }
  try {
    const r = await consultar(
        'INSERT INTO agendamentos (nome, telefone, endereco, data, hora, observacao) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [String(nome).trim(), String(telefone).trim(), String(endereco).trim(), data, hora, observacao ? String(observacao).trim() : null]
    );
    res.status(201).json({ id: r.rows[0].id, nome, data, hora });
  } catch (e) {
    if (e.code === '23505' || /unique/i.test(e.message)) {
      return res.status(409).json({ erro: 'Esse horário não está mais disponível.' });
    }
    throw e;
  }
}));

app.get('/api/admin/agendamentos', exigirAdmin, rota(async (req, res) => {
  const r = req.query.todos
      ? await consultar('SELECT * FROM agendamentos ORDER BY data, hora')
      : await consultar('SELECT * FROM agendamentos WHERE data >= $1 ORDER BY data, hora', [hoje()]);
  res.json(r.rows);
}));

app.patch('/api/admin/agendamentos/:id', exigirAdmin, rota(async (req, res) => {
  const { status } = req.body;
  if (!['confirmado', 'cancelado', 'concluido'].includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }
  const r = await consultar('UPDATE agendamentos SET status = $1 WHERE id = $2', [status, req.params.id]);
  if (!r.count) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  res.json({ ok: true });
}));

app.delete('/api/admin/agendamentos/:id', exigirAdmin, rota(async (req, res) => {
  const r = await consultar('DELETE FROM agendamentos WHERE id = $1', [req.params.id]);
  if (!r.count) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
});

iniciarBanco()
    .then(() => {
      if (DATABASE_URL && ADMIN_PASSWORD === 'admin123') {
        console.warn('ATENÇÃO: defina ADMIN_PASSWORD com uma senha forte.');
      }
      app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
    })
    .catch((e) => {
      console.error('Falha ao iniciar o banco:', e.message);
      process.exit(1);
    });
