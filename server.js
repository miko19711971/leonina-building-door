// src/server.js
import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ====== ENV ======
const SHELLY_API_KEY  = process.env.SHELLY_API_KEY || "";
const SHELLY_BASE_URL = process.env.SHELLY_BASE_URL || "https://shelly-api-eu.shelly.cloud";
const TOKEN_SECRET    = process.env.TOKEN_SECRET || "changeme";
const TIMEZONE        = process.env.TIMEZONE || "Europe/Rome";

// ====== MAPPATURA TUTTI I DEVICE ======
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

const RELAY_CHANNEL = 0;

// ====== Shelly Cloud (v1) ======
async function cloudOpenRelay(deviceId) {
  if (!SHELLY_API_KEY) {
    return { ok:false, error:"missing_api_key" };
  }
  const url = `${SHELLY_BASE_URL}/device/relay/control`;
  const form = new URLSearchParams({
    id: deviceId,
    auth_key: SHELLY_API_KEY,
    channel: String(RELAY_CHANNEL),
    turn: "on"
  });

  try {
    const resp = await axios.post(url, form.toString(), {
      headers: { "Content-Type":"application/x-www-form-urlencoded" },
      timeout: 10000,
      validateStatus: () => true // vogliamo vedere anche i 4xx
    });
    const data = resp.data;
    if (data && data.isok === true) {
      return { ok:true, step:"v1", status: resp.status, data };
    } else {
      // rendi VISIBILE tutto quello che ha risposto il cloud
      return { ok:false, step:"v1", error:"cloud_error", status: resp.status, data };
    }
  } catch (err) {
    return { ok:false, step:"v1", error:"cloud_exception", details: String(err) };
  }
}

// ====== TOKEN MONOUSO 5 MIN ======
const usedTokens = new Map();

function makeToken(target) {
  const ts = Date.now();
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(`${target}:${ts}`).digest("base64url");
  return { ts, sig };
}

function verifyToken(target, ts, sig) {
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(`${target}:${ts}`).digest("base64url");
  if (sig !== expected) return { ok:false, error:"invalid_signature" };

  const ageMs = Date.now() - parseInt(ts, 10);
  if (!Number.isFinite(ageMs) || ageMs > 5*60*1000) return { ok:false, error:"expired" };

  if (usedTokens.has(sig)) return { ok:false, error:"already_used" };
  usedTokens.set(sig, Date.now() + 5*60*1000);
  return { ok:true };
}

setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of usedTokens.entries()) if (exp < now) usedTokens.delete(sig);
}, 60*1000);

// ====== ROUTES ======

// Home con link
app.get("/", (req, res) => {
  const items = Object.entries(TARGETS).map(([k, v]) => {
    return `<li><b>${k}</b> — ${v.name}
      &nbsp; <a href="/gen/${k}">gen token</a>
      &nbsp; <a href="/open?target=${k}">test open</a>
      &nbsp; <a href="/test-open-token?target=${k}">test open (token)</a>
      &nbsp; <a href="/t/${k}">smart link (redirect)</a>
      &nbsp; <a href="/diag/${k}">diag</a>
    </li>`;
  }).join("\n");
  res.type("html").send(`<h1>Shelly unified opener</h1>
  <p>${Object.keys(TARGETS).length} targets configured. TZ=${TIMEZONE}</p>
  <ul>${items}</ul>
  <p><a href="/health">/health</a></p>`);
});

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!SHELLY_API_KEY,
    baseUrl: SHELLY_BASE_URL,
    tz: TIMEZONE,
    node: process.version
  });
});

// Genera token (vista link firmato)
app.get("/gen/:target", (req, res) => {
  const target = req.params.target;
  if (!TARGETS[target]) return res.json({ ok:false, error:"unknown_target" });
  const { ts, sig } = makeToken(target);
  res.json({ ok:true, target, ts, sig, url: `${req.protocol}://${req.get("host")}/open/${target}/${ts}/${sig}` });
});

// Smart redirect
app.get("/t/:target", (req, res) => {
  const target = req.params.target;
  if (!TARGETS[target]) return res.status(404).send("unknown_target");
  const { ts, sig } = makeToken(target);
  res.redirect(302, `/open/${target}/${ts}/${sig}`);
});

// Apertura (con token)
app.get("/open/:target/:ts/:sig", async (req, res) => {
  const { target, ts, sig } = req.params;
  if (!TARGETS[target]) return res.json({ ok:false, error:"unknown_target" });

  const check = verifyToken(target, ts, sig);
  if (!check.ok) return res.json(check);

  const out = await cloudOpenRelay(TARGETS[target].id);
  res.json(out);
});

// Apertura senza token (test)
app.get("/open", async (req, res) => {
  const key = req.query.target;
  if (!TARGETS[key]) return res.json({ ok:false, error:"unknown_target" });
  const out = await cloudOpenRelay(TARGETS[key].id);
  res.json(out);
});

// Diagnostica dettagliata (mostra tutto)
app.get("/diag/:target", async (req, res) => {
  const key = req.params.target;
  if (!TARGETS[key]) return res.json({ ok:false, error:"unknown_target" });
  const out = await cloudOpenRelay(TARGETS[key].id);
  res.json({ target:key, device_id: TARGETS[key].id, result: out });
});

// ====== START ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT, "TZ:", TIMEZONE);
});
