// src/server.js
import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ====== ENV ======
const SHELLY_API_KEY  = process.env.SHELLY_API_KEY; // obbligatoria
const SHELLY_BASE_URL = process.env.SHELLY_BASE_URL || "https://shelly-api-eu.shelly.cloud";
const TOKEN_SECRET    = process.env.TOKEN_SECRET || "changeme";
const TIMEZONE        = process.env.TIMEZONE || "Europe/Rome";
const PORT            = Number(process.env.PORT || 10000);

// ====== TARGETS ======
const TARGETS = {
  "leonina-door":                   { id: "3494547a9395", name: "Leonina — Apartment Door" },
  "leonina-building-door":          { id: "34945479fbbe", name: "Leonina — Building Door" },
  "scala-door":                     { id: "3494547a1075", name: "Scala — Apartment Door" },
  "scala-building-door":            { id: "3494547745ee", name: "Scala — Building Door" },
  "ottavia-door":                   { id: "3494547a887d", name: "Ottavia — Apartment Door" },
  "ottavia-building-door":          { id: "3494547ab62b", name: "Ottavia — Building Door" },
  "viale-trastevere-door":          { id: "34945479fa35", name: "Viale Trastevere — Apartment Door" },
  "viale-trastevere-building-door": { id: "34945479fd73", name: "Viale Trastevere — Building Door" },
  "arenula-building-door":          { id: "3494547ab05e", name: "Arenula — Building Door" }
};

// Shelly 1 => relay channel 0
const RELAY_CHANNEL = 0;

// ====== TOKEN monouso (5 minuti) ======
const usedTokens = new Map();

function makeToken(target) {
  const ts = Date.now();
  const sig = crypto.createHmac("sha256", TOKEN_SECRET)
    .update(`${target}:${ts}`)
    .digest("base64url");
  return { ts, sig };
}

function verifyToken(target, tsStr, sig) {
  const expected = crypto.createHmac("sha256", TOKEN_SECRET)
    .update(`${target}:${tsStr}`)
    .digest("base64url");

  if (sig !== expected) return { ok:false, error:"invalid_signature" };
  const ts = Number(tsStr);
  const age = Date.now() - ts;
  if (!Number.isFinite(ts) || age < 0 || age > 5*60*1000) return { ok:false, error:"expired" };
  if (usedTokens.has(sig)) return { ok:false, error:"already_used" };

  usedTokens.set(sig, ts + 5*60*1000);
  return { ok:true };
}

// pulizia token scaduti
setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of usedTokens.entries()) if (exp < now) usedTokens.delete(sig);
}, 60_000);

// ====== Chiamate Shelly Cloud ======

// v1: /device/relay/control  (Gen1)
async function shellyV1_On(deviceId) {
  const url = `${SHELLY_BASE_URL}/device/relay/control`;
  const form = new URLSearchParams({
    id: deviceId,
    auth_key: SHELLY_API_KEY,
    channel: String(RELAY_CHANNEL),
    turn: "on"
  });
  const { data, status } = await axios.post(url, form.toString(), {
    headers: { "Content-Type":"application/x-www-form-urlencoded" },
    timeout: 10000
  });
  if (data?.isok) return { ok:true, data, api:"v1" };
  const err = new Error("v1_failed");
  err.status = status;
  err.payload = data;
  throw err;
}

// v2 RPC: /device/rpc  (Plus/Gen2)
async function shellyV2_On(deviceId) {
  const url = `${SHELLY_BASE_URL}/device/rpc`;
  const body = {
    id: deviceId,
    auth_key: SHELLY_API_KEY,
    method: "Switch.Set",
    params: { id: 0, on: true }
  };
  const { data, status } = await axios.post(url, body, { timeout: 10000 });
  // le risposte v2 tipicamente non hanno isok; se non c'è errore HTTP consideriamo ok
  if (status >= 200 && status < 300) return { ok:true, data, api:"v2" };
  const err = new Error("v2_failed");
  err.status = status;
  err.payload = data;
  throw err;
}

// tenta v1, se "wrong_type"/simili prova v2
async function openTarget(targetKey) {
  if (!SHELLY_API_KEY) return { ok:false, error:"missing_api_key" };
  const t = TARGETS[targetKey];
  if (!t) return { ok:false, error:"unknown_target" };

  try {
    const r1 = await shellyV1_On(t.id);
    return r1;
  } catch (e) {
    const msg = JSON.stringify(e?.payload || {});
    const looksWrongType = msg.includes("wrong_type") || msg.includes("Could not control this device type");
    const unauthorized = (e?.status === 401);
    if (!looksWrongType && !unauthorized) {
      return { ok:false, step:"v1", error:"cloud_error", details:{ status:e?.status, data:e?.payload } };
    }
    // fallback a v2
    try {
      const r2 = await shellyV2_On(t.id);
      return r2;
    } catch (e2) {
      return { ok:false, step:"v2", error:"cloud_error", details:{ status:e2?.status, data:e2?.payload } };
    }
  }
}

// ====== ROUTES ======

// Home con link di test
app.get("/", (req, res) => {
  const list = Object.entries(TARGETS).map(([k, v]) =>
    `<li><b>${k}</b> — ${v.name}
       · <a href="/t/${k}">smart link</a>
       · <a href="/open?target=${k}">test open</a>
       · <a href="/test-open-token?target=${k}">test open (token)</a>
     </li>`).join("\n");
  res.type("html").send(`<h1>Shelly unified opener</h1>
  <p>${Object.keys(TARGETS).length} targets · TZ=${TIMEZONE}</p>
  <ul>${list}</ul>
  <p><a href="/health">/health</a></p>`);
});

// Health
app.get("/health", (req, res) => {
  res.json({ ok:true, hasApiKey: !!SHELLY_API_KEY, base:SHELLY_BASE_URL, tz: TIMEZONE, node: process.version });
});

// test senza token
app.get("/open", async (req, res) => {
  const key = req.query.target;
  const out = await openTarget(key);
  res.status(out.ok ? 200 : 400).json(out);
});

// smart link (crea token e redirect)
app.get("/t/:target", (req, res) => {
  const key = req.params.target;
  if (!TARGETS[key]) return res.status(404).send("unknown_target");
  const { ts, sig } = makeToken(key);
  res.redirect(302, `/open/${encodeURIComponent(key)}/${ts}/${encodeURIComponent(sig)}`);
});

// apertura con token
app.get("/open/:target/:ts/:sig", async (req, res) => {
  const { target, ts, sig } = req.params;
  if (!TARGETS[target]) return res.json({ ok:false, error:"unknown_target" });
  const check = verifyToken(target, ts, sig);
  if (!check.ok) return res.status(401).json(check);
  const out = await openTarget(target);
  res.status(out.ok ? 200 : 400).json(out);
});

// tool: mostra link tokenizzato senza aprire
app.get("/test-open-token", (req, res) => {
  const key = req.query.target;
  if (!TARGETS[key]) return res.json({ ok:false, error:"unknown_target" });
  const { ts, sig } = makeToken(key);
  const url = `${req.protocol}://${req.get("host")}/open/${key}/${ts}/${sig}`;
  res.json({ ok:true, url, ts, sig, target:key });
});

app.listen(PORT, () => {
  console.log("Server listening on", PORT, "TZ:", TIMEZONE);
});
