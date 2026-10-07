const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;

// Persistent game state.
// Render persistent disk байвал /var/data ашиглана.
const DATA_DIR =
  process.env.MP_DATA_DIR ||
  (fs.existsSync('/var/data')
    ? '/var/data'
    : path.join(__dirname, 'data'));

const STATE_FILE = path.join(
  DATA_DIR,
  'mongol-poker-tables.json'
);

fs.mkdirSync(DATA_DIR, { recursive: true });

let tables = Object.create(null);

try {
  if (fs.existsSync(STATE_FILE)) {
    tables =
      JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) ||
      Object.create(null);
  }
} catch (e) {
  console.error('State load failed:', e);
  tables = Object.create(null);
}

let saveTimer = null;

function saveNow() {
  const tmp = STATE_FILE + '.tmp';

  fs.writeFileSync(
    tmp,
    JSON.stringify(tables),
    'utf8'
  );

  fs.renameSync(tmp, STATE_FILE);
}

function scheduleSave() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    try {
      saveNow();
    } catch (e) {
      console.error('State save failed:', e);
    }
  }, 25);
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
}

function getTable(tableId) {
  return tables[tableId] || null;
}

// -------------------------
// HEALTH
// -------------------------

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'MONGOL_POKER_SERVER',
    persistentGameState: true
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    now: Date.now(),
    tables: Object.keys(tables).length
  });
});

// -------------------------
// READ EXISTING GAME
// -------------------------
// Refresh / гараад буцаж ороход
// шинэ hand үүсгэхгүй.
// Одоо байгаа state-г буцаана.

app.get('/api/tables/:tableId/state', (req, res) => {
  const tableId = cleanId(req.params.tableId);
  const state = getTable(tableId);

  if (!state) {
    return res.status(404).json({
      ok: false,
      code: 'TABLE_STATE_NOT_FOUND'
    });
  }

  res.json({
    ok: true,
    state
  });
});

// -------------------------
// INITIALIZE ONCE
// -------------------------

app.post('/api/tables/:tableId/init', (req, res) => {
  const tableId = cleanId(req.params.tableId);

  if (!tableId) {
    return res.status(400).json({
      ok: false,
      code: 'BAD_TABLE_ID'
    });
  }

  // Table аль хэдийн байгаа бол
  // дахин hand эхлүүлэхгүй.
  if (tables[tableId]) {
    return res.json({
      ok: true,
      created: false,
      state: tables[tableId]
    });
  }

  const incoming =
    req.body &&
    req.body.state &&
    typeof req.body.state === 'object'
      ? req.body.state
      : {};

  tables[tableId] = {
    ...incoming,
    tableId,
    revision: 1,
    updatedAt: Date.now()
  };

  scheduleSave();

  res.json({
    ok: true,
    created: true,
    state: tables[tableId]
  });
});

// -------------------------
// UPDATE GAME STATE
// -------------------------
// Revision protection:
// 2 утас хуучин state-аар
// бие биеэ overwrite хийхээс хамгаална.

app.put('/api/tables/:tableId/state', (req, res) => {
  const tableId = cleanId(req.params.tableId);

  const incoming =
    req.body &&
    req.body.state;

  const expectedRevision =
    Number(req.body && req.body.expectedRevision);

  if (
    !tableId ||
    !incoming ||
    typeof incoming !== 'object'
  ) {
    return res.status(400).json({
      ok: false,
      code: 'BAD_STATE'
    });
  }

  const current = tables[tableId];

  if (!current) {
    return res.status(409).json({
      ok: false,
      code: 'INIT_REQUIRED'
    });
  }

  const currentRevision =
    Number(current.revision || 0);

  if (
    Number.isFinite(expectedRevision) &&
    expectedRevision !== currentRevision
  ) {
    return res.status(409).json({
      ok: false,
      code: 'STALE_STATE',
      state: current
    });
  }

  tables[tableId] = {
    ...incoming,
    tableId,
    revision: currentRevision + 1,
    updatedAt: Date.now()
  };

  scheduleSave();

  res.json({
    ok: true,
    state: tables[tableId]
  });
});

// -------------------------
// PLAYER PRESENCE
// -------------------------
// Browser/Messenger-ээс гарах нь
// hand устгах ёсгүй.

app.post('/api/tables/:tableId/presence', (req, res) => {
  const tableId = cleanId(req.params.tableId);

  const playerId = cleanId(
    req.body && req.body.playerId
  );

  const online =
    !!(req.body && req.body.online);

  const current = tables[tableId];

  if (!current || !playerId) {
    return res.status(404).json({
      ok: false,
      code: 'TABLE_OR_PLAYER_NOT_FOUND'
    });
  }

  const presence = {
    ...(current.presence || {})
  };

  presence[playerId] = {
    online,
    at: Date.now()
  };

  tables[tableId] = {
    ...current,
    presence,
    revision: Number(current.revision || 0) + 1,
    updatedAt: Date.now()
  };

  scheduleSave();

  res.json({
    ok: true,
    state: tables[tableId]
  });
});

// -------------------------
// SAFE SHUTDOWN
// -------------------------

process.on('SIGTERM', () => {
  try {
    saveNow();
  } catch (_) {}

  process.exit(0);
});

process.on('SIGINT', () => {
  try {
    saveNow();
  } catch (_) {}

  process.exit(0);
});

// -------------------------
// START SERVER
// -------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `MONGOL_POKER_SERVER listening on port ${PORT}; state=${STATE_FILE}`
  );
});
