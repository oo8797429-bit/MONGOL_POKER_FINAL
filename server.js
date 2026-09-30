const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT || 10000);
const SERVICE_ACCOUNT =
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  '/etc/secrets/firebase-service-account.json';

const DB_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://mongol-poker-default-rtdb.firebaseio.com';

if (!fs.existsSync(SERVICE_ACCOUNT)) {
  throw new Error(`Firebase service account missing: ${SERVICE_ACCOUNT}`);
}

const credential = JSON.parse(
  fs.readFileSync(SERVICE_ACCOUNT, 'utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(credential),
  databaseURL: DB_URL
});

const db = admin.database();

const ACTION_MS = 20000;
const RAKE = 0.02;
const timers = new Map();

const n = v =>
  Number.isFinite(Number(v)) ? Number(v) : 0;

const cleanId = v =>
  String(v || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);

const tableRef = id =>
  db.ref(`game/tables/${cleanId(id)}`);

function deck() {
  const d = [];

  for (const s of ['S', 'H', 'D', 'C']) {
    for (let r = 2; r <= 14; r++) {
      d.push({ r, s });
    }
  }

  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }

  return d;
}

function active(t) {
  return Object.entries(t.players || {}).filter(
    ([, p]) =>
      p &&
      p.status !== 'left' &&
      n(p.chips) > 0
  );
}

function nextSeat(t, from) {
  const seats = active(t)
    .filter(([, p]) => !p.folded && !p.allIn)
    .map(([, p]) => n(p.seat))
    .sort((a, b) => a - b);

  if (!seats.length) return null;

  return seats.find(s => s > from) ?? seats[0];
}

function playerBySeat(t, seat) {
  return Object.entries(t.players || {}).find(
    ([, p]) => n(p.seat) === n(seat)
  );
}

function publicTable(t, viewer) {
  const x = JSON.parse(JSON.stringify(t || {}));

  delete x.deck;

  for (const [uid, p] of Object.entries(x.players || {})) {
    if (uid !== viewer && x.phase !== 'showdown') {
      delete p.hole;
    }
  }

  return x;
}

function armTimer(tableId, t) {
  clearTimeout(timers.get(tableId));

  if (
    !t?.handId ||
    t.phase === 'showdown' ||
    t.turnSeat == null
  ) {
    return;
  }

  const hand = t.handId;
  const seat = t.turnSeat;

  timers.set(
    tableId,
    setTimeout(async () => {
      const snap = await tableRef(tableId).get();
      const cur = snap.val();

      if (
        cur?.handId === hand &&
        cur?.turnSeat === seat
      ) {
        await applyAction(
          tableId,
          null,
          'fold',
          0,
          true
        );
      }
    }, Math.max(0, n(t.turnDeadline) - Date.now()) || ACTION_MS)
  );
}

async function startHand(tableId) {
  let out;

  await tableRef(tableId).transaction(t => {
    if (!t) return t;

    const ps = active(t);

    if (
      ps.length < 2 ||
      (t.handId && t.phase !== 'showdown')
    ) {
      return t;
    }

    const d = deck();
    const dealer = nextSeat(t, n(t.dealerSeat));

    t.handId =
      `h_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    t.phase = 'preflop';
    t.board = [];
    t.pot = 0;
    t.currentBet = 0;
    t.deck = d;
    t.dealerSeat = dealer;

    for (const [, p] of ps) {
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
      p.roundBet = 0;
      p.hole = [d.pop(), d.pop()];
    }

    const sbSeat = nextSeat(t, dealer);
    const bbSeat = nextSeat(t, sbSeat);

    const sb = playerBySeat(t, sbSeat);
    const bb = playerBySeat(t, bbSeat);

    const sbAmt = Math.min(
      n(t.smallBlind || 100),
      n(sb?.[1].chips)
    );

    const bbAmt = Math.min(
      n(t.bigBlind || 200),
      n(bb?.[1].chips)
    );

    if (sb) {
      sb[1].chips -= sbAmt;
      sb[1].bet += sbAmt;
      sb[1].roundBet += sbAmt;
      t.pot += sbAmt;
    }

    if (bb) {
      bb[1].chips -= bbAmt;
      bb[1].bet += bbAmt;
      bb[1].roundBet += bbAmt;
      t.pot += bbAmt;
      t.currentBet = bbAmt;
    }

    t.turnSeat = nextSeat(t, bbSeat);
    t.turnDeadline = Date.now() + ACTION_MS;
    t.updatedAt = Date.now();

    out = t;

    return t;
  });

  if (out) armTimer(tableId, out);

  return out;
}

function remaining(t) {
  return active(t).filter(([, p]) => !p.folded);
}

function roundComplete(t) {
  const live = remaining(t).filter(
    ([, p]) => !p.allIn
  );

  if (live.length <= 1) return true;

  return live.every(
    ([, p]) =>
      n(p.roundBet) === n(t.currentBet) &&
      p.acted
  );
}

function advance(t) {
  for (const p of Object.values(t.players || {})) {
    p.roundBet = 0;
    p.acted = false;
  }

  t.currentBet = 0;

  if (t.phase === 'preflop') {
    t.phase = 'flop';
    t.board.push(
      t.deck.pop(),
      t.deck.pop(),
      t.deck.pop()
    );
  } else if (t.phase === 'flop') {
    t.phase = 'turn';
    t.board.push(t.deck.pop());
  } else if (t.phase === 'turn') {
    t.phase = 'river';
    t.board.push(t.deck.pop());
  } else {
    t.phase = 'showdown';
    t.turnSeat = null;
    t.turnDeadline = null;
    return;
  }

  t.turnSeat = nextSeat(t, t.dealerSeat);
  t.turnDeadline = Date.now() + ACTION_MS;
}

async function applyAction(
  tableId,
  uid,
  action,
  amount = 0,
  timeout = false
) {
  let out;
  let err;

  await tableRef(tableId).transaction(t => {
    if (!t?.handId || t.phase === 'showdown') {
      err = 'NO_ACTIVE_HAND';
      return;
    }

    const hit = playerBySeat(t, t.turnSeat);

    if (!hit) {
      err = 'NO_TURN_PLAYER';
      return;
    }

    const [turnUid, p] = hit;

    if (!timeout && turnUid !== uid) {
      err = 'NOT_YOUR_TURN';
      return;
    }

    const need = Math.max(
      0,
      n(t.currentBet) - n(p.roundBet)
    );

    if (action === 'fold') {
      p.folded = true;
    } else if (action === 'check') {
      if (need > 0) {
        err = 'CANNOT_CHECK';
        return;
      }

      p.acted = true;
    } else if (action === 'call') {
      const pay = Math.min(need, n(p.chips));

      p.chips -= pay;
      p.bet += pay;
      p.roundBet += pay;
      t.pot += pay;

      p.allIn = p.chips <= 0;
      p.acted = true;
    } else if (action === 'raise') {
      const target = Math.max(
        n(t.currentBet) + n(t.bigBlind || 200),
        n(amount)
      );

      const pay = Math.min(
        Math.max(0, target - n(p.roundBet)),
        n(p.chips)
      );

      if (pay <= need) {
        err = 'RAISE_TOO_SMALL';
        return;
      }

      p.chips -= pay;
      p.bet += pay;
      p.roundBet += pay;
      t.pot += pay;

      p.allIn = p.chips <= 0;
      t.currentBet = p.roundBet;

      for (const q of Object.values(t.players || {})) {
        if (
          q !== p &&
          !q.folded &&
          !q.allIn
        ) {
          q.acted = false;
        }
      }

      p.acted = true;
    } else {
      err = 'BAD_ACTION';
      return;
    }

    const left = remaining(t);

    if (left.length === 1) {
      const [winUid, w] = left[0];

      const rake = Math.floor(
        n(t.pot) * RAKE
      );

      w.chips += n(t.pot) - rake;

      t.rakeTotal =
        n(t.rakeTotal) + rake;

      t.lastResult = {
        winnerUid: winUid,
        pot: n(t.pot),
        rake,
        at: Date.now()
      };

      t.phase = 'showdown';
      t.turnSeat = null;
      t.turnDeadline = null;
    } else if (roundComplete(t)) {
      advance(t);
    } else {
      t.turnSeat = nextSeat(
        t,
        t.turnSeat
      );

      t.turnDeadline =
        Date.now() + ACTION_MS;
    }

    t.updatedAt = Date.now();
    out = t;

    return t;
  });

  if (err) throw new Error(err);

  if (out) armTimer(tableId, out);

  return out;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'MONGOL_POKER_SERVER',
    engine: 'authoritative-v1'
  });
});

app.get('/health', async (req, res) => {
  try {
    await db
      .ref('.info/serverTimeOffset')
      .get();

    res.json({
      ok: true,
      firebase: true,
      now: Date.now()
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: e.message
    });
  }
});

app.post(
  '/api/tables/:id/start',
  async (req, res) => {
    try {
      const t = await startHand(
        req.params.id
      );

      res.json({
        ok: true,
        table: publicTable(
          t,
          req.body?.uid
        )
      });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: e.message
      });
    }
  }
);

app.get(
  '/api/tables/:id',
  async (req, res) => {
    try {
      const t = (
        await tableRef(
          req.params.id
        ).get()
      ).val();

      res.json({
        ok: true,
        table: publicTable(
          t,
          req.query.uid
        )
      });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: e.message
      });
    }
  }
);

app.post(
  '/api/tables/:id/action',
  async (req, res) => {
    try {
      const {
        uid,
        action,
        amount
      } = req.body || {};

      const t = await applyAction(
        req.params.id,
        cleanId(uid),
        String(action || ''),
        n(amount)
      );

      res.json({
        ok: true,
        table: publicTable(t, uid)
      });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: e.message
      });
    }
  }
);

app.listen(
  PORT,
  '0.0.0.0',
  async () => {
    console.log(
      `MONGOL_POKER_SERVER authoritative engine listening on ${PORT}`
    );

    const snap = await db
      .ref('game/tables')
      .get()
      .catch(() => null);

    for (
      const [id, t]
      of Object.entries(
        snap?.val() || {}
      )
    ) {
      armTimer(id, t);
    }
  }
);
