const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const SERVICE_ACCOUNT_PATH =
  "/etc/secrets/firebase-service-account.json";

const DATABASE_URL =
  "https://mongol-poker-default-rtdb.firebaseio.com";

let db = null;
let firebaseReady = false;
let firebaseError = null;

try {
  const serviceAccount = JSON.parse(
    fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });

  db = admin.database();
  firebaseReady = true;

  console.log("Firebase Admin connected");
} catch (err) {
  firebaseError = err.message;
  console.error("Firebase Admin failed:", err.message);
}


/* =========================
   BASIC STATUS
========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "MONGOL_POKER_SERVER",
    firebase: firebaseReady ? "connected" : "not_connected"
  });
});


app.get("/health", async (req, res) => {
  if (!firebaseReady || !db) {
    return res.status(500).json({
      ok: false,
      firebase: "not_connected",
      error: firebaseError
    });
  }

  try {
    await db.ref(".info/connected").once("value");

    res.json({
      ok: true,
      firebase: "connected",
      database: "mongol-poker-default-rtdb",
      now: Date.now()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      firebase: "error",
      error: err.message
    });
  }
});


/* =========================
   HELPERS
========================= */

function gameRef(tableId) {
  return db.ref("sharedGames/" + String(tableId));
}

function cleanTableId(id) {
  return String(id || "")
    .trim()
    .replace(/[.#$\/]/g, "_")
    .slice(0, 120);
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function alivePlayers(state) {
  if (!Array.isArray(state.players)) return [];

  return state.players
    .map((p, i) => ({
      index: i,
      player: p,
      folded: !!state.folded?.[i]
    }))
    .filter(x =>
      x.player &&
      !x.folded &&
      Number(x.player.chips || 0) >= 0
    );
}

function nextAliveSeat(state, from) {
  const players = Array.isArray(state.players)
    ? state.players
    : [];

  if (!players.length) return -1;

  for (let n = 1; n <= players.length; n++) {
    const i = (Number(from || 0) + n) % players.length;

    if (
      players[i] &&
      !state.folded?.[i] &&
      Number(players[i].chips || 0) > 0
    ) {
      return i;
    }
  }

  return -1;
}

function normalizeState(state, tableId) {
  state = state || {};

  state.tableId = String(tableId);

  if (!Array.isArray(state.players))
    state.players = [];

  if (!Array.isArray(state.folded))
    state.folded = state.players.map(() => false);

  if (!Array.isArray(state.liveSeatBets))
    state.liveSeatBets = state.players.map(() => 0);

  if (!Array.isArray(state.liveSeatStatus))
    state.liveSeatStatus = state.players.map(() => "");

  state.potAmt =
    Math.max(0, Number(state.potAmt) || 0);

  state.street =
    Math.max(0, Number(state.street) || 0);

  state.handNo =
    Math.max(0, Number(state.handNo) || 0);

  return state;
}

async function saveServerState(tableId, state) {
  state.savedAt = Date.now();
