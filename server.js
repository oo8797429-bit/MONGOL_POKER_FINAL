
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.MP_DATA_DIR ||
  (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));

fs.mkdirSync(DATA_DIR, { recursive: true });

const FILE = path.join(DATA_DIR, 'mongol-poker-tables.json');
let tables = Object.create(null);

try {
  if (fs.existsSync(FILE)) {
    tables = JSON.parse(fs.readFileSync(FILE, 'utf8')) || Object.create(null);
  }
} catch (e) {
  console.error('State load failed', e);
}

function persist() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tables));
  fs.renameSync(tmp, FILE);
}

function id(x) {
  return String(x ?? '').trim()
    .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function tableOf(req) {
  return tables[id(req.params.tableId)];
}

function fail(res, code, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, code, ...extra });
}

function update(t) {
  t.revision = (Number(t.revision) || 0) + 1;
  t.updatedAt = Date.now();
  persist();
  return t;
}

const suits = ['♠', '♥', '♦', '♣'];

function deck() {
  const d = [];
  for (const s of suits) {
    for (let r = 2; r <= 14; r++) d.push({ s, r });
  }
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function take(t) {
  return t.deck.pop();
}

function occupied(t) {
  return t.players.map((p, i) => p && p.chips > 0 ? i : -1)
    .filter(i => i >= 0);
}

function next(t, from) {
  for (let j = 1; j <= t.players.length; j++) {
    const i = (from + j) % t.players.length;
    if (t.players[i] && t.players[i].chips > 0 && !t.folded[i]) return i;
  }
  return -1;
}

function newHand(t) {
  const active = occupied(t);
  if (active.length < 2) {
    t.finished = true;
    t.liveTurn = -1;
    return;
  }

  t.deck = deck();
  t.boardCards = [];
  t.street = 0;
  t.potAmt = 0;
  t.finished = false;
  t.handNo = (t.handNo || 0) + 1;
  t.folded = t.players.map(p => !p || p.chips <= 0);
  t.liveSeatBets = t.players.map(() => 0);
  t.holes = t.players.map(p =>
    p && p.chips > 0
      ? Array.from({
          length: t.currentTable.type === 'omaha' ? 4 : 2
        }, () => take(t))
      : []
  );

  t.liveDealer = next(t,
    Number.isInteger(t.liveDealer) ? t.liveDealer : active[active.length - 1]
  );
  t.liveSB = next(t, t.liveDealer);
  t.liveBB = next(t, t.liveSB);

  for (const [i, n] of [
    [t.liveSB, t.currentTable.sb],
    [t.liveBB, t.currentTable.bb]
  ]) {
    const v = Math.min(t.players[i].chips, Math.max(0, Number(n) || 0));
    t.players[i].chips -= v;
    t.liveSeatBets[i] += v;
    t.potAmt += v;
  }

  t.toCall = Math.max(...t.liveSeatBets);
  t.liveTurn = next(t, t.liveBB);
  t.turnDeadline = Date.now() + 20000;
  t.statusText = 'Тоглолт эхэллээ';
}

function score5(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a);
  const count = {};
  rs.forEach(r => count[r] = (count[r] || 0) + 1);

  const groups = Object.entries(count)
    .map(([r, n]) => [+n, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  const flush = cs.every(c => c.s === cs[0].s);
  const uniq = [...new Set(rs)];
  if (uniq.includes(14)) uniq.push(1);

  let straight = 0;
  for (let i = 0; i <= uniq.length - 5; i++) {
    if (uniq[i] - uniq[i + 4] === 4) {
      straight = uniq[i];
      break;
    }
  }

  if (flush && straight) return [8, straight];
  if (groups[0][0] === 4)
    return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] >= 2)
    return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...rs];
  if (straight) return [4, straight];
  if (groups[0][0] === 3)
    return [3, groups[0][1],
      ...groups.slice(1).map(x => x[1]).sort((a, b) => b - a)];
  if (groups[0][0] === 2 && groups[1][0] === 2)
    return [2,
      Math.max(groups[0][1], groups[1][1]),
      Math.min(groups[0][1], groups[1][1]),
      groups[2][1]];
  if (groups[0][0] === 2)
    return [1, groups[0][1],
      ...groups.slice(1).map(x => x[1]).sort((a, b) => b - a)];

  return [0, ...rs];
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const v = (a[i] || 0) - (b[i] || 0);
    if (v) return v;
  }
  return 0;
}

function best(t, i) {
  const hole = t.holes[i] || [];
  const board = t.boardCards || [];
  let bestScore = null;

  function evalFive(cs) {
    const s = score5(cs);
    if (!bestScore || cmp(s, bestScore) > 0) bestScore = s;
  }

  if (t.currentTable.type === 'omaha') {
    for (let a = 0; a < hole.length; a++)
      for (let b = a + 1; b < hole.length; b++)
        for (let c = 0; c < board.length; c++)
          for (let d = c + 1; d < board.length; d++)
            for (let e = d + 1; e < board.length; e++)
              evalFive([
                hole[a], hole[b], board[c], board[d], board[e]
              ]);
  } else {
    const all = [...hole, ...board];
    for (let a = 0; a < all.length; a++)
      for (let b = a + 1; b < all.length; b++)
        for (let c = b + 1; c < all.length; c++)
          for (let d = c + 1; d < all.length; d++)
            for (let e = d + 1; e < all.length; e++)
              evalFive([
                all[a], all[b], all[c], all[d], all[e]
              ]);
  }

  return bestScore || [0];
}

function finish(t) {
  while (t.boardCards.length < 5) t.boardCards.push(take(t));

  const alive = t.players
    .map((p, i) => p && !t.folded[i] ? i : -1)
    .filter(i => i >= 0);

  let winners = [];

  if (alive.length === 1) {
    winners = alive;
  } else {
    let bestScore = null;
    for (const i of alive) {
      const s = best(t, i);
      if (!bestScore || cmp(s, bestScore) > 0) {
        bestScore = s;
        winners = [i];
      } else if (cmp(s, bestScore) === 0) {
        winners.push(i);
      }
    }
  }

  const rake = Math.floor(t.potAmt * 0.02);
  t.rakeTotal = (t.rakeTotal || 0) + rake;

  const award = t.potAmt - rake;
  winners.forEach((i, k) => {
    t.players[i].chips +=
      Math.floor(award / winners.length) +
      (k < award % winners.length ? 1 : 0);
  });

  t.liveWinner = winners[0] ?? -1;
  t.showdownWinners = winners;
  t.potAmt = 0;
  t.finished = true;
  t.liveTurn = -1;
  t.turnDeadline = 0;
  t.statusText = 'Гар дууслаа';
}

function advance(t) {
  const active = t.players
    .map((p, i) => p && !t.folded[i] ? i : -1)
    .filter(i => i >= 0);

  if (active.length <= 1) return finish(t);
  if (t.street >= 3) return finish(t);

  t.street++;
  for (let k = 0; k < (t.street === 1 ? 3 : 1); k++)
    t.boardCards.push(take(t));

  t.liveSeatBets = t.players.map(() => 0);
  t.toCall = 0;
  t.liveTurn = next(t, t.liveDealer);
  t.turnDeadline = Date.now() + 20000;
}

function publicState(t, playerId) {
  const s = JSON.parse(JSON.stringify(t));
  delete s.deck;

  const viewer = s.players.findIndex(
    p => p && p.playerId === playerId
  );

  if (!s.finished) {
    s.holes = s.holes.map((h, i) => i === viewer ? h : []);
  }
  return s;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'MONGOL_POKER_SERVER'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    now: Date.now(),
    tables: Object.keys(tables).length
  });
});

app.get('/api/tables/:tableId/state', (req, res) => {
  const t = tableOf(req);
  if (!t) return fail(res, 'TABLE_STATE_NOT_FOUND', 404);

  res.json({
    ok: true,
    state: publicState(t, id(req.query.playerId))
  });
});

app.post('/api/tables/:tableId/join', (req, res) => {
  const tableId = id(req.params.tableId);
  const pid = id(req.body.playerId);

  if (!tableId || !pid) return fail(res, 'BAD_ID');

  let t = tables[tableId];
  let joinedNew = false;

  if (!t) {
    const meta = req.body.table || {};
    const buy = Math.max(0, Number(meta.buy) || 0);

    t = {
      tableId,
      currentTable: {
        ...meta,
        id: tableId,
        type: meta.type === 'omaha' ? 'omaha' : 'texas',
        sb: Number(meta.sb) || 100,
        bb: Number(meta.bb) || 200
      },
      players: [],
      holes: [],
      folded: [],
      revision: 0,
      handNo: 0,
      liveDealer: -1,
      rakeTotal: 0
    };

    const bots = (
      Array.isArray(req.body.players) ? req.body.players : []
    ).filter(p => p.botId).slice(0, 5);

    t.players.push({
      playerId: pid,
      name: String(req.body.players?.[0]?.name || pid).slice(0, 40),
      chips: buy,
      emoji: '😎',
      user: true
    });

    for (const b of bots) {
      t.players.push({
        playerId: 'bot_' + id(b.botId),
        botId: b.botId,
        name: String(b.name || 'Bot').slice(0, 40),
        chips: Math.max(0, Number(b.chips) || buy),
        emoji: b.emoji || '🤖'
      });
    }

    joinedNew = true;
    tables[tableId] = t;
    newHand(t);
  } else if (!t.players.some(p => p.playerId === pid)) {
    if (t.players.length >= 9)
      return fail(res, 'TABLE_FULL', 409);

    t.players.push({
      playerId: pid,
      name: String(req.body.players?.[0]?.name || pid).slice(0, 40),
      chips: Math.max(0, Number(t.currentTable.buy) || 0),
      emoji: '😎',
      user: true
    });

    joinedNew = true;
  }

  update(t);

  res.json({
    ok: true,
    joinedNew,
    state: publicState(t, pid)
  });
});

app.post('/api/tables/:tableId/action', (req, res) => {
  const t = tableOf(req);
  const pid = id(req.body.playerId);

  if (!t) return fail(res, 'TABLE_NOT_FOUND', 404);

  const i = t.players.findIndex(p => p.playerId === pid);
  if (i < 0) return fail(res, 'NOT_SEATED', 403);

  if (t.finished)
    return fail(res, 'HAND_FINISHED', 409, {
      state: publicState(t, pid)
    });

  if (i !== t.liveTurn)
    return fail(res, 'NOT_YOUR_TURN', 409, {
      state: publicState(t, pid)
    });

  const action = req.body.action;
  const needed = Math.max(
    0, t.toCall - t.liveSeatBets[i]
  );

  if (action === 'fold') {
    t.folded[i] = true;
  } else if (action === 'check') {
    if (needed)
      return fail(res, 'CALL_REQUIRED', 409, {
        state: publicState(t, pid)
      });
  } else if (action === 'call' || action === 'raise') {
    let amt = action === 'raise'
      ? Number(req.body.amount)
      : needed;

    if (!Number.isFinite(amt) || amt < needed)
      return fail(res, 'BAD_BET', 400);

    amt = Math.min(Math.floor(amt), t.players[i].chips);

    t.players[i].chips -= amt;
    t.potAmt += amt;
    t.liveSeatBets[i] += amt;
    t.toCall = Math.max(t.toCall, t.liveSeatBets[i]);
  } else {
    return fail(res, 'BAD_ACTION');
  }

  t.liveTurn = next(t, i);

  if (t.liveTurn < 0 || t.liveTurn === i) {
    advance(t);
  } else {
    t.turnDeadline = Date.now() + 20000;
  }

  update(t);

  res.json({
    ok: true,
    state: publicState(t, pid)
  });
});

app.post('/api/tables/:tableId/presence', (req, res) => {
  const t = tableOf(req);
  const pid = id(req.body.playerId);

  if (!t) return fail(res, 'TABLE_NOT_FOUND', 404);

  t.presence = t.presence || {};
  t.presence[pid] = {
    online: !!req.body.online,
    at: Date.now()
  };

  update(t);

  res.json({
    ok: true,
    state: publicState(t, pid)
  });
});

app.post('/api/tables/:tableId/init', (req, res) => {
  const key = id(req.params.tableId);
  if (!key) return fail(res, 'BAD_TABLE_ID');

  if (!tables[key]) {
    tables[key] = {
      ...(req.body.state || {}),
      tableId: key,
      revision: 0
    };
    update(tables[key]);
  }

  res.json({
    ok: true,
    created: false,
    state: tables[key]
  });
});

app.put('/api/tables/:tableId/state', (req, res) => {
  return fail(res, 'SERVER_AUTHORITATIVE_STATE', 403);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      persist();
    } catch (e) {
      console.error(e);
    }
    process.exit(0);
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('MONGOL_POKER_SERVER listening on ' + PORT);
});
