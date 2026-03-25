const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Database setup (Turso / libSQL)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:database.sqlite',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL,
      telefone TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      qr_code INTEGER NOT NULL CHECK(qr_code BETWEEN 1 AND 3),
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(email, qr_code)
    );

    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      won_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Init DB on startup
const dbReady = initDB().catch(e => {
  console.error('Erro ao inicializar banco:', e);
});

// Ensure DB is ready before handling requests
app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (e) {
    console.error('DB not ready:', e);
    res.status(500).json({ error: 'Database not available' });
  }
});

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// QR Code scan entry point
app.get('/scan/:qrId', (req, res) => {
  const qrId = parseInt(req.params.qrId);
  if (qrId < 1 || qrId > 3) {
    return res.status(400).send('QR Code inválido');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Register scan
app.post('/api/register', async (req, res) => {
  try {
    const { nome, email, telefone, qr_code } = req.body;

    if (!nome || !email || !telefone || !qr_code) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    const emailNorm = email.trim().toLowerCase();
    const qrNum = parseInt(qr_code);

    if (qrNum < 1 || qrNum > 3) {
      return res.status(400).json({ error: 'QR Code inválido' });
    }

    // Check if already a winner
    const alreadyWon = await db.execute({ sql: 'SELECT * FROM winners WHERE email = ?', args: [emailNorm] });
    if (alreadyWon.rows.length > 0) {
      const scansResult = await db.execute({ sql: 'SELECT qr_code FROM scans WHERE email = ?', args: [emailNorm] });
      const scans = scansResult.rows.map(s => s.qr_code);
      return res.json({
        success: true,
        already_winner: true,
        scans,
        total: scans.length,
        message: 'Você já resgatou seu prêmio! 🎉'
      });
    }

    // Upsert participante
    const existing = await db.execute({ sql: 'SELECT * FROM participantes WHERE email = ?', args: [emailNorm] });
    if (existing.rows.length > 0) {
      await db.execute({ sql: 'UPDATE participantes SET nome = ?, telefone = ? WHERE email = ?', args: [nome.trim(), telefone.trim(), emailNorm] });
    } else {
      await db.execute({ sql: 'INSERT OR IGNORE INTO participantes (nome, email, telefone) VALUES (?, ?, ?)', args: [nome.trim(), emailNorm, telefone.trim()] });
    }

    // Register scan
    await db.execute({ sql: 'INSERT OR IGNORE INTO scans (email, qr_code) VALUES (?, ?)', args: [emailNorm, qrNum] });

    // Check total scans
    const scansResult = await db.execute({ sql: 'SELECT qr_code FROM scans WHERE email = ?', args: [emailNorm] });
    const scans = scansResult.rows.map(s => s.qr_code);
    const isComplete = scans.length === 3;

    if (isComplete) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO winners (email) VALUES (?)', args: [emailNorm] });
    }

    res.json({
      success: true,
      scans,
      total: scans.length,
      is_complete: isComplete,
      message: isComplete
        ? 'Parabéns! Você escaneou os 3 QR Codes e ganhou o prêmio! 🎉🐰'
        : `QR Code ${qrNum} registrado! Faltam ${3 - scans.length} QR Code(s).`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Check status by email
app.get('/api/status/:email', async (req, res) => {
  try {
    const emailNorm = req.params.email.trim().toLowerCase();
    const participante = await db.execute({ sql: 'SELECT * FROM participantes WHERE email = ?', args: [emailNorm] });

    if (participante.rows.length === 0) {
      return res.json({ found: false });
    }

    const scansResult = await db.execute({ sql: 'SELECT qr_code FROM scans WHERE email = ?', args: [emailNorm] });
    const scans = scansResult.rows.map(s => s.qr_code);
    const won = await db.execute({ sql: 'SELECT * FROM winners WHERE email = ?', args: [emailNorm] });

    res.json({
      found: true,
      nome: participante.rows[0].nome,
      scans,
      total: scans.length,
      is_winner: won.rows.length > 0
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/participantes', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT p.nome, p.email, p.telefone, p.created_at,
        GROUP_CONCAT(s.qr_code) as qrs_scanned,
        COUNT(s.qr_code) as total_scans,
        CASE WHEN w.email IS NOT NULL THEN 1 ELSE 0 END as is_winner
      FROM participantes p
      LEFT JOIN scans s ON p.email = s.email
      LEFT JOIN winners w ON p.email = w.email
      GROUP BY p.email
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro interno' });
  }
});



// Export participants as CSV
app.get('/api/admin/export', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT p.nome, p.email, p.telefone, p.created_at,
        GROUP_CONCAT(s.qr_code) as qrs_scanned,
        COUNT(s.qr_code) as total_scans,
        CASE WHEN w.email IS NOT NULL THEN 1 ELSE 0 END as is_winner
      FROM participantes p
      LEFT JOIN scans s ON p.email = s.email
      LEFT JOIN winners w ON p.email = w.email
      GROUP BY p.email
      ORDER BY p.created_at DESC
    `);
    const rows = result.rows;

    const BOM = '\uFEFF';
    const header = 'Nome;Email;Telefone;QR Codes;Status;Data';
    const csvRows = rows.map(p => {
      const qrs = p.qrs_scanned ? p.qrs_scanned.split(',').sort().join(', ') : '-';
      const status = p.is_winner ? 'Ganhador' : `${p.total_scans}/3`;
      const date = new Date(p.created_at + 'Z').toLocaleString('pt-BR');
      return [p.nome, p.email, p.telefone, `QR ${qrs}`, status, date]
        .map(v => `"${(v || '').replace(/"/g, '""')}"`)
        .join(';');
    });

    const csv = BOM + header + '\n' + csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=convidados.csv');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao exportar' });
  }
});


// Start server (local dev only, Vercel uses the export)
if (!process.env.VERCEL) {
  dbReady.then(() => {
    app.listen(PORT, () => {
      console.log(`\n🐰 Inter Café Páscoa - QR Code Campaign`);
      console.log(`📍 Server: http://localhost:${PORT}`);
      console.log(`📊 Admin:  http://localhost:${PORT}/admin\n`);
    });
  });
}

module.exports = app;
