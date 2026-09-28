const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SERVICE_ACCOUNT_PATH =
  "/etc/secrets/firebase-service-account.json";

let db = null;
let firebaseReady = false;
let firebaseError = null;

try {
  const serviceAccount = JSON.parse(
    fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://mongol-poker-default-rtdb.firebaseio.com"
  });

  db = admin.database();
  firebaseReady = true;

  console.log("Firebase Admin connected");
} catch (err) {
  firebaseError = err.message;
  console.error("Firebase Admin failed:", err.message);
}

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `MONGOL_POKER_SERVER listening on port ${PORT}`
  );
});
