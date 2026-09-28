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

/* =========================
   FIREBASE
========================= */

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
   HELPERS
========================= */

function tableRef(tableId) {
  return db.ref("serverPoker/tables/" + String(tableId));
}

function cleanTableId(value) {
  return String(value || "").trim();
}

function defaultState(tableId) {
  return {
    tableId: String(tableId),

    handNo: 0,
    phase: "waiting",

    pot: 0,
    street: 0,

    dealerSeat: -1,
    currentSeat: -1,

    board: [],

    seats: {},

    currentBet: 0,
    minRaise: 200,

    turnStartedAt: 0,
    turnDeadline: 0,

    rakeTotal: 0,

    createdAt: Date.now(),
    savedAt: Date.now()
  };
}

function normalizeState(tableId, value) {
  const state =
    value && typeof value === "object"
      ? value
      : defaultState(tableId);

  state.tableId = String(tableId);

  if (!state.seats || typeof state.seats !== "object") {
    state.seats = {};
  }

  if (!Array.isArray(state.board)) {
    state.board = [];
  }

  state.pot = Math.max(0, Number(state.pot) || 0);
  state.currentBet =
    Math.max(0, Number(state.currentBet) || 0);

  state.minRaise =
    Math.max(200, Number(state.minRaise) || 200);

  state.street =
    Math.max(0, Number(state.street) || 0);

  state.handNo =
    Math.max(0, Number(state.handNo) || 0);

  state.rakeTotal =
    Math.max(0, Number(state.rakeTotal) || 0);

  return state;
}

async function readServerState(tableId) {
  const snap = await tableRef(tableId).once("value");

  return normalizeState(
    tableId,
    snap.val()
  );
}

async function saveServerState(tableId, state) {
  state.savedAt = Date.now();

  await tableRef(tableId).set(state);

  return state;
}

function activeSeats
