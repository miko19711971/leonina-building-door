// src/server.js
import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ====== ENV ======
const SHELLY_API_KEY = process.env.SHELLY_API_KEY; // la tua chiave Shelly Cloud
const SHELLY_BASE_URL = process.env.SHELLY_BASE_URL || "https://shelly-api-eu.shelly.cloud";
const TOKEN_SECRET = process.env.TOKEN_SECRET || "changeme";
const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";

// ====== DEVICE MAP ======
const TARGETS = {
  "leonina-door": { id: "3494547a9395", name: "Leonina — Apartment Door" },
  "leonina-building-door": { id: "34945479fbbe", name: "Leonina — Building Door" },
  "scala-door": { id: "3494547a1075", name: "Scala — Apartment Door" },
  "scala-building-door": { id: "3494547745ee", name: "Scala — Building Door" },
  "ottavia-door": { id: "3494547a887d", name: "Ottavia — Apartment Door" },
  "ottavia-building-door": { id: "3494547ab62b", name: "Ottavia — Building Door" },
  "viale-trastevere-door": { id: "34945479fa35", name: "Viale Trastevere — Apartment Door" },
  "viale-trastevere-building-door": { id: "34945479fd73", name: "Viale Trastevere — Building Door" },
  "arenula-building-door": { id: "3494547ab05e", name: "Arenula — Building Door" }
};

// Shelly 1 usa sempre relay channel 0
const RELAY_CHANNEL = 0;

// ====== HELPER: chiamata al Cloud v1 ======
async function cloudOpenRelay(deviceId) {
  const url = `${SHELLY_BASE_URL}/device/relay/control`;
  const form = new URLSearchParams({
    id: deviceId,
    auth_key: SHELLY_API_KEY,
    channel: String(RELAY_CHANNEL),
    turn: "on"
  });

  try {
    const { data } = await axios.post(url, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000
    });
    if (data && data.isok) return { ok: true, data };
    return { ok: false, error: data || { message: "cloud_isok_false" } };
  } catch (err) {
    return {
      ok: false,
      error: "cloud_error",
      details: err.response ? { status: err.response.status, data: err.response.data } : String(err)
    };
  }
}

// ====== TOKEN GIORNALIERO ======
function tokenFor(target, dateStr) {
  const payload = `${target}:${dateStr}`;
  return crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
}

function todayISO() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const [{ value: y }, , { value: m }, , { value: d }] = fmt.formatToParts(new Date());
  return `${y}-${m}-${d}`;
}

// ====== ROUTES ======
app.get("/", (req, res) => {
  const rows = Object.entries(TARGETS)
    .map(([key, v]) => {
      return `<li>
        <b>${key}</b> — ${v.name}
        &nbsp; <a href="/gen/${key}">gen token</a>
        &nbsp; <a href="/open?target=${key}">test open</a>
        &nbsp; <a href="/test-open-token?target=${key}">test open (token)</a>
        &nbsp; <a href="/t/${key}">smart link</a>
      </li>`;
    })
    .join("\n");

  res.type("html").send(
    `<h1>Shelly unified opener</h1>
     <p>${Object.keys(TARGETS).length} targets configured. TZ=${TIMEZONE}</p>
     <ul>${rows}</ul>
     <p><a href="/health">/health</a></p>`
  );
});

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!SHELLY_API_KEY,
    hasBase: !!SHELLY_BASE_URL,
    timezone: TIMEZONE,
    today: todayISO(),
    node: process.version
  });
});

// Genera token giornaliero
app.get("/gen/:target", (req, res) => {
  const target = req.params.target;
  if (!TARGETS[target]) return res.json({ ok: false, error: "unknown_target" });

  const date = todayISO();
  const sig = tokenFor(target, date);
  const url = `${req.protocol}://${req.get("host")}/open/${target}/${date}/${sig}`;
  res.json({ ok: true, target, date, sig, url });
});

// Apertura senza token (debug)
app.get("/open", async (req, res) => {
  const target = req.query.target;
  if (!TARGETS[target]) return res.json({ ok: false, error: "unknown_target" });
  const deviceId = TARGETS[target].id;
  const out = await cloudOpenRelay(deviceId);
  res.json(out);
});

// Apertura con token
app.get("/open/:target/:date/:sig", async (req, res) => {
  const { target, date, sig } = req.params;
  if (!TARGETS[target]) return res.json({ ok: false, error: "unknown_target" });

  const expected = tokenFor(target, date);
  if (sig !== expected) return res.json({ ok: false, error: "invalid_token" });

  if (date !== todayISO()) return res.json({ ok: false, error: "expired_or_wrong_date" });

  const deviceId = TARGETS[target].id;
  const out = await cloudOpenRelay(deviceId);
  res.json(out);
});

// Test token (senza aprire)
app.get("/test-open-token", (req, res) => {
  const target = req.query.target;
  if (!TARGETS[target]) return res.json({ ok: false, error: "unknown_target" });

  const date = todayISO();
  const sig = tokenFor(target, date);
  const url = `${req.protocol}://${req.get("host")}/open/${target}/${date}/${sig}`;
  res.json({ ok: true, target, date, sig, url });
});

// Smart redirect
app.get("/t/:target", (req, res) => {
  const target = req.params.target;
  if (!TARGETS[target]) return res.status(404).send("unknown_target");
  const date = todayISO();
  const sig = tokenFor(target, date);
  res.redirect(302, `/open/${target}/${date}/${sig}`);
});

// Diagnostica
app.get("/diag/:id", async (req, res) => {
  const deviceId = req.params.id;
  try {
    const url = `${SHELLY_BASE_URL}/device/status`;
    const form = new URLSearchParams({
      id: deviceId,
      auth_key: SHELLY_API_KEY
    });

    const { data } = await axios.post(url, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    res.json({ ok: true, deviceId, data });
  } catch (err) {
    res.json({
      ok: false,
      error: "diag_failed",
      details: err.response ? err.response.data : String(err)
    });
  }
});

// START
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT, "TZ:", TIMEZONE);
});
