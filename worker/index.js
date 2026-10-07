/* ===========================================================================
   Prince Alex TicketHub - Cloudflare Worker API
   Powered by Prince Alex Digital
   ---------------------------------------------------------------------------
   Bindings : env.DB (D1)  env.BUCKET (R2)
   Secrets  : PAYSTACK_SECRET_KEY, PAYMENT_ENCRYPTION_KEY, FIREBASE_PROJECT_ID
              TURNSTILE_SECRET (bot protection; legacy name TURNSTILE_SECRET_KEY
              is still read), PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET
              PAYHERO_API_USERNAME, PAYHERO_API_PASSWORD, PAYHERO_CHANNEL_ID
              BREVO_API_KEY (transactional email)
              FREE_TICKET_OTP_KEY (free-ticket verification: keys the OTP, email
              and IP hashes. Falls back to PAYMENT_ENCRYPTION_KEY, then
              TURNSTILE_SECRET, so an existing deployment keeps working.)
   Vars     : ALLOWED_ORIGINS (csv), FRONTEND_URL, PESAPAL_ENV (sandbox|live)
              PAYHERO_BASE_URL (optional, defaults to the live PayHero API)
              EMAIL_FROM, EMAIL_FROM_NAME, EMAIL_REPLY_TO, EMAIL_DISABLED
              TURNSTILE_HOSTNAMES (csv, optional - hostnames allowed to solve a
              challenge; defaults to the production host + workers.dev + local)
   Three payment providers (pesapal | paystack | payhero) sit behind ONE payment
   service. Organizers configure any subset of them, pick one active provider,
   and nothing but the provider adapter changes downstream.
   Frontend is NEVER trusted: Firebase ID tokens are cryptographically verified,
   all money is recalculated from D1, payment status comes from provider
   verification/webhooks only, and tickets are issued only after that.
   =========================================================================== */
"use strict";

/* ============================================================================
   TRANSACTIONAL EMAIL
   ----------------------------------------------------------------------------
   emails.js owns the templates, the Brevo transport (BREVO_API_KEY) and the
   email_outbox queue. Nothing here ever throws into a payment path: a mail
   problem can never fail an order that has already been paid.
   Deploy: `wrangler deploy` bundles this relative import automatically. If you
   edit the Worker in the Cloudflare dashboard, add emails.js as a module in the
   same project - both files are required.
   ========================================================================== */
import {
  queueEmail, dispatchSoon, dispatchOutbox, requeueEmail, sendTemplateNow, sendTestEmail,
  isEmailConfigured, isTemplate, templateList, templateCategory, outboxRowView, outboxStats,
  emailStatus, loadEmailSettings, resetEmailSettingsCache, brandOf, base64Encode,
  normalisePayloadLinks, mergeEmailLinks
} from "./emails.js";

/* ------------------------------------------------------------ constants ---- */
const API_NAME = "Prince Alex TicketHub API";
/* Production frontend origin. Email links, payment callbacks and public event
   URLs must land on this site even when the FRONTEND_URL var is missing -
   the old fallback (the Worker's own origin) served only the API, so any
   email sent without FRONTEND_URL linked to a dead URL. FRONTEND_URL still
   wins when set (staging, local dev). */
const PRODUCTION_FRONTEND_URL = "https://tickethub.princealex.digital";
const EVENT_STATUSES = ["draft","pending","active","paused","ended","cancelled"];
const ORDER_STATUSES = ["pending","paid","failed","cancelled","refunded"];
const TICKET_TYPE_STATUSES = ["active","paused","hidden"];
const CATEGORIES = ["Music","Conferences","Sports","Church","Education","Business","Community","Other"];
const POSTER_TYPES = { "image/jpeg":"jpg", "image/jpg":"jpg", "image/png":"png", "image/webp":"webp" };
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const PENDING_ORDER_TTL_MIN = 30;   // unpaid orders release inventory after this
const CORS_MAX_AGE = "86400";

/* ============================================================================
   FREE TICKET VERIFICATION - tunables
   ----------------------------------------------------------------------------
   Every number here is a *default*. A deployment can override the rate windows
   with plain-text vars (`FREE_OTP_IP_LIMIT`, `FREE_REGISTER_IP_LIMIT`, ...), and
   an organizer can tighten them per event through events.free_ticket_config
   (validated and clamped below - a value outside the safe bounds is refused, so
   an event can never disable its own abuse protection by asking for 0 or 99999).
   ========================================================================== */
const FREE_OTP_TTL_SEC = 300;              // 6-digit code lives 5 minutes
const FREE_OTP_MAX_ATTEMPTS = 5;           // wrong guesses per issued code
const FREE_OTP_RESEND_COOLDOWN_SEC = 60;   // wait between "resend" taps
const FREE_OTP_MAX_RESENDS = 5;            // reissues per verification session
const FREE_SESSION_TTL_SEC = 900;          // time to finish verification
const FREE_CONTINUE_TTL_SEC = 600;         // life of the continuation token
const FREE_TICKET_LIMIT_MAX = 5;           // ceiling for events.free_ticket_limit
const FREE_TICKET_LIMIT_MIN = 1;
/* Safe bounds for the per-event threshold overrides. */
const FREE_RATE_BOUNDS = {
  otp_ip_limit:     { min: 3,  max: 20,   dflt: 5 },
  otp_ip_window:    { min: 300, max: 3600, dflt: 900 },
  register_ip_limit:{ min: 5,  max: 50,   dflt: 10 },
  register_ip_window:{ min: 300, max: 3600, dflt: 900 }
};
/* The only provider keys the platform knows. Order matters: it is the order the
   organizer dashboard lists them in. */
const PAYMENT_PROVIDER_KEYS = ["pesapal", "paystack", "payhero"];
/* Connection states shown in the organizer payment settings (and stored). */
const CONNECTION_STATUSES = ["not_connected", "connected", "configuration_required", "error"];

/* --------------------------------------------------------------- http ------ */
function json(data, status, extraHeaders){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extraHeaders || {})
  });
}
function ok(data, headers){ return json(Object.assign({ success: true }, data || {}), 200, headers); }
function created(data, headers){ return json(Object.assign({ success: true }, data || {}), 201, headers); }
class ApiError extends Error {
  constructor(status, message, code){ super(message); this.status = status; this.code = code || ""; }
}
const err = (status, message, code) => new ApiError(status, message, code);
/* Classifies an unexpected 5xx into a stable, non-sensitive code so the browser
   and the Worker logs say *what* broke without exposing internals. */
function serverErrorCode(env, e){
  const m = String((e && e.message) || e || "");
  if(!env || !env.DB) return "DB_NOT_BOUND";
  if(/no such table|no such column/i.test(m)) return "DB_SCHEMA";
  if(/CHECK constraint failed/i.test(m)) return "DB_CONSTRAINT";
  if(/parameter bindings/i.test(m)) return "DB_BINDINGS";
  if(/D1_ERROR/i.test(m)) return "DB_ERROR";
  if(/prepare|\.bind is not a function|\.all is not a function|\.run is not a function/i.test(m)) return "DB_NOT_BOUND";
  if(/Could not load token signing keys/i.test(m)) return "NETWORK";
  /* Key-material failures must be self-describing. The retired build fetched
     Google's X.509 *certificates* and fed the certificate DER into
     importKey("spki", ...), which BoringSSL rejects with exactly
     "Invalid SPKI input." and the 500 was reported as a generic SERVER_ERROR. */
  if(/SPKI|JWK|Unable to import|Invalid key/i.test(m)) return "CERT_IMPORT";
  return "SERVER_ERROR";
}
function errorResponse(e, env, request){
  const status = (e instanceof ApiError && e.status) ? e.status : 500;
  let message = (e instanceof ApiError) ? e.message : "Something went wrong. Please try again.";
  let code = (e instanceof ApiError ? e.code : "") || "";
  if(status >= 500){
    if(!code) code = serverErrorCode(env, e);
    console.error("TICKETHUB_ERROR", code, (e && e.message) || String(e));
    if(e && e.stack) console.error("TICKETHUB_STACK", e.stack);
    /* A database that predates a migration is an operator problem, not a buyer
       problem. Say what to run instead of a bare 500, so the fix is one command
       rather than a debugging session. The code is its own kind so a client can
       tell it apart from an ordinary server fault. Which file to run depends on
       what is missing, so point at the health endpoint that answers precisely. */
    if(code === "DB_SCHEMA" || code === "DB_CONSTRAINT"){
      code = "MIGRATION_REQUIRED";
      message = "This server's database is missing a required migration, so payments cannot be taken yet. GET /api/health reports exactly which one to apply from worker/migrations/, then try again.";
    }
  }
  const headers = request ? corsFor(env, request) : corsHeaders(env, { "Allow": "GET,POST,PUT,DELETE,OPTIONS" });
  const body = { success: false, error: message, code: code || undefined };
  /* A route may attach machine-readable fields - the agreement gate does, so a
     dashboard can show the exact reason a publication was refused instead of
     parsing English. Only what the route chose is ever echoed back. */
  if(e && e.details && typeof e.details === "object") body.details = e.details;
  /* 429 also answers with the standard header and an explicit wait, so a client
     (or Cloudflare) knows when the request may be retried. The message stays
     generic: which limit was hit is not something a caller should learn. */
  if(e && e.retryAfter){
    headers["Retry-After"] = String(e.retryAfter);
    body.message = message;
    body.retry_after = Number(e.retryAfter);
  }
  return json(body, status, headers);
}

/* --------------------------------------------------------------- cors ------ */
function allowedOrigins(env){
  const list = new Set();
  for(const o of String(env.ALLOWED_ORIGINS || "").split(",")) { const t = o.trim(); if(t) list.add(t.replace(/\/+$/, "")); }
  if(env.FRONTEND_URL) list.add(String(env.FRONTEND_URL).trim().replace(/\/+$/, ""));
  /* The production site is always allowed, even before ALLOWED_ORIGINS /
     FRONTEND_URL are configured - emails and pages link here. */
  list.add(PRODUCTION_FRONTEND_URL);
  list.add("https://princealextickethub.princealexdigital.workers.dev");
  list.add("http://localhost:8000"); list.add("http://127.0.0.1:8000");
  list.add("http://localhost:5500");  list.add("http://127.0.0.1:5500");
  return list;
}
function corsHeaders(env, extra){
  const list = allowedOrigins(env);
  const headers = Object.assign({
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
    "Access-Control-Max-Age": CORS_MAX_AGE,
    "Vary": "Origin"
  }, extra || {});
  return headers;
}
function corsFor(env, request, extra){
  const origin = request.headers.get("Origin") || "";
  const list = allowedOrigins(env);
  const headers = corsHeaders(env, extra);
  /* "*" in ALLOWED_ORIGINS means "allow any origin": echo the request's Origin
     back instead of emitting a literal "*" so the header stays compatible with
     future credentialed flows and keeps "Vary: Origin" cache-correct. */
  if(origin && (list.has("*") || list.has(origin.replace(/\/+$/, "")))) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function preflight(env, request){
  return new Response(null, { status: 204, headers: corsFor(env, request) });
}
/* Safety net: every response that leaves the Worker carries the CORS headers for
   the caller's origin. Routes may (and do) pass corsFor() explicitly; this only
   fills in what a route forgot, so one missing header can never turn a valid
   request into an opaque "CORS error" in the browser. Existing values win, which
   keeps the 204 preflight, CSV downloads and cache headers untouched. */
function withCors(env, request, response){
  if(!response) return response;
  const extra = corsFor(env, request);
  for(const key of Object.keys(extra)){
    if(!response.headers.has(key)){
      try { response.headers.set(key, extra[key]); } catch(e){ /* immutable headers: keep as-is */ }
    }
  }
  return response;
}

/* -------------------------------------------------------------- crypto ----- */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomToken(bytes){
  const buf = new Uint8Array(bytes || 24);
  crypto.getRandomValues(buf);
  let s = ""; for(const b of buf) s += B64[b & 63];
  return s;
}
function randomDigits(n){
  const buf = new Uint8Array(n); crypto.getRandomValues(buf);
  let s = ""; for(const b of buf) s += String(b % 10);
  return s;
}
function b64urlEncode(buf){
  const bytes = new Uint8Array(buf); let bin = "";
  for(const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/, "");
}
function b64urlDecode(str){
  let s = String(str).replace(/-/g,"+").replace(/_/g,"/");
  while(s.length % 4) s += "=";
  const bin = atob(s); const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function utf8(str){ return new TextEncoder().encode(str); }
async function hmacSha256Hex(secret, message){
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, utf8(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2,"0")).join("");
}
/* AES-GCM credential encryption. Key material = PAYMENT_ENCRYPTION_KEY secret.
   Stored format: v1.<iv b64url>.<ciphertext b64url> */
async function paymentKey(env){
  const raw = String(env.PAYMENT_ENCRYPTION_KEY || "");
  if(!raw || raw.length < 16) throw err(500, "Payment credential encryption is not configured on the server.", "KEY_MISSING");
  const digest = await crypto.subtle.digest("SHA-256", utf8(raw));
  return crypto.subtle.importKey("raw", digest, { name:"AES-GCM" }, false, ["encrypt","decrypt"]);
}
async function encryptSecret(env, plaintext){
  const key = await paymentKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, utf8(String(plaintext)));
  return "v1." + b64urlEncode(iv) + "." + b64urlEncode(ct);
}
async function decryptSecret(env, stored){
  const parts = String(stored || "").split(".");
  if(parts.length !== 3 || parts[0] !== "v1") return null;
  const key = await paymentKey(env);
  const pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv: new Uint8Array(b64urlDecode(parts[1])) }, key, b64urlDecode(parts[2]));
  return new TextDecoder().decode(pt);
}
const maskSecret = s => { const t = String(s || ""); return t ? (t.slice(0,4) + "..." + t.slice(-2)) : ""; };

/* ------------------------------------------------- firebase id token ------- */
/* Cryptographically verifies a Firebase ID token (RS256) against Google's
   JWK signing keys, then checks iss/aud/exp. Never trusts payload. */
let GOOGLE_CERTS = null, GOOGLE_CERTS_AT = 0;
async function googleCerts(force){
  const now = Date.now();
  if(force || !GOOGLE_CERTS || now - GOOGLE_CERTS_AT > 3600 * 1000){
    const res = await fetch("https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com");
    if(!res.ok) throw err(500, "Could not load token signing keys.", "CERTS");
    const jwks = await res.json();
    // The JWK endpoint returns { keys: [{kid,n,e,...}] }; transform into a
    // kid-keyed map so verifyFirebaseToken can look up by header.kid.
    GOOGLE_CERTS = {};
    for(const k of (jwks.keys || [])) GOOGLE_CERTS[k.kid] = k;
    GOOGLE_CERTS_AT = now;
  }
  return GOOGLE_CERTS;
}
async function importJwk(jwk){
  /* WebCrypto turns a JWK into its DER form before parsing, so a malformed or
     non-key value surfaces as an opaque DOMException - e.g. a certificate DER
     passed to the "spki" format throws "Invalid SPKI input.". Convert that into
     a named server error so the log says *what* broke, never a bare 500. */
  try {
    return await crypto.subtle.importKey("jwk", jwk, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["verify"]);
  } catch(e){
    throw err(500, "Could not load token signing keys.", "CERTS");
  }
}
async function verifyFirebaseToken(env, token){
  if(!token || typeof token !== "string" || token.length > 4096) throw err(401, "Please sign in to continue.", "UNAUTHENTICATED");
  const projectId = env.FIREBASE_PROJECT_ID;
  if(!projectId) throw err(500, "Firebase project is not configured on the server.", "FB_NOT_CONFIGURED");
  const parts = token.split(".");
  if(parts.length !== 3) throw err(401, "Your session is invalid. Please sign in again.", "BAD_TOKEN");
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch(e){ throw err(401, "Your session is invalid. Please sign in again.", "BAD_TOKEN"); }
  if(header.alg !== "RS256") throw err(401, "Your session is invalid. Please sign in again.", "BAD_ALG");
  let certs = await googleCerts();
  let jwk = certs && certs[header.kid];
  if(!jwk){
    /* The kid is not in the cached set — most likely Google rotated keys while
       the cache was still fresh. Refresh once before rejecting so a rotation
       can never block sign-ins for the remainder of the cache hour. */
    certs = await googleCerts(true);
    jwk = certs && certs[header.kid];
  }
  if(!jwk) throw err(401, "Your session is invalid. Please sign in again.", "UNKNOWN_KID");
  const key = await importJwk(jwk);
  const data = utf8(parts[0] + "." + parts[1]);
  const sigBytes = new Uint8Array(b64urlDecode(parts[2]));
  const sigBuf = new ArrayBuffer(sigBytes.length); new Uint8Array(sigBuf).set(sigBytes);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBuf, data);
  if(!valid) throw err(401, "Your session is invalid. Please sign in again.", "BAD_SIG");
  const nowSec = Math.floor(Date.now() / 1000);
  if(payload.exp && payload.exp < nowSec) throw err(401, "Your session has expired. Please sign in again.", "TOKEN_EXPIRED");
  if(payload.iat && payload.iat > nowSec + 300) throw err(401, "Your session is invalid. Please sign in again.", "TOKEN_FUTURE");
  if(payload.aud !== projectId) throw err(401, "Your session is invalid. Please sign in again.", "BAD_AUD");
  if(payload.iss !== "https://securetoken.google.com/" + projectId) throw err(401, "Your session is invalid. Please sign in again.", "BAD_ISS");
  if(!payload.sub) throw err(401, "Your session is invalid. Please sign in again.", "NO_SUB");
  return { uid: payload.sub, email: payload.email || null, name: payload.name || null, email_verified: !!payload.email_verified };
}

/* ============================================================================
   CLOUDFLARE TURNSTILE  -  server-side enforcement
   ----------------------------------------------------------------------------
   The frontend renders a *managed* Turnstile widget and puts the single-use
   token in the protected request body as `turnstile_token`. Every protected
   route calls requireTurnstile() BEFORE it does any work, so a direct API call
   can never skip the challenge. Firebase authentication, organizer ownership
   checks and rate limits all stay in force on top of it.

   What is enforced here (Cloudflare's documented token contract):
     - a token is 10..2048 characters, URL-safe, valid for 300 seconds and can
       be redeemed once only (a replay answers `timeout-or-duplicate`)
     - Siteverify must answer success:true, from a hostname this site is really
       served from, for the action the route expects
     - a Siteverify timeout, 5xx, malformed body or network failure fails the
       action safely (503) - verification is never silently skipped

   The secret is read from env only: TURNSTILE_SECRET (falls back to the older
   TURNSTILE_SECRET_KEY name). It is never hardcoded, logged, echoed to a
   response or sent to the browser. Payment webhooks/IPN callbacks never pass
   through here: they authenticate with their own signatures.
   ========================================================================== */
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_MAX_TOKEN = 2048;            // Cloudflare's documented maximum
const TURNSTILE_MIN_TOKEN = 10;              // shortest real / dummy token
const TURNSTILE_TIMEOUT_MS = 8000;           // never hang a request on Siteverify
const TURNSTILE_TTL_MS = 5 * 60 * 1000;      // tokens live 300 seconds
/* Hostnames this application is actually served from. `www.` is deliberately
   NOT listed - the site is published on the bare host (PRODUCTION_FRONTEND_URL
   and the email/callback links all use it). Override or extend this with the
   plain-text var TURNSTILE_HOSTNAMES (csv), e.g.
       TURNSTILE_HOSTNAMES = "tickethub.princealex.digital"
   to be strict in production, or add "www.tickethub.princealex.digital" if the
   site ever starts serving that hostname too. */
const TURNSTILE_HOSTNAMES_DEFAULT = [
  "tickethub.princealex.digital",
  "princealextickethub.princealexdigital.workers.dev",
  "localhost", "127.0.0.1", "0.0.0.0"        // local `python -m http.server` dev
];
/* Actions accepted by POST /api/auth/turnstile - the Firebase-client-only
   flows whose pages render the widget with the same action value. */
const TURNSTILE_CLIENT_ACTIONS = ["login", "password-reset", "email-verification"];

function turnstileSecret(env){
  const raw = (env && (env.TURNSTILE_SECRET || env.TURNSTILE_SECRET_KEY)) || "";
  return String(raw).trim();
}
/* Cloudflare's documented dummy secrets (1x..AA / 2x..AA / 3x..AA) are made to
   be used in development: they decide success themselves and report their own
   hostname/action, so the hostname + action checks are skipped for them only.
   success:true is still required, and a dummy secret can only ever be set
   deliberately by whoever configures the Worker. */
function turnstileTestSecret(secret){
  return /^[123]x0{20,}A{2}$/.test(String(secret || ""));
}
function turnstileHostnames(env){
  const set = new Set();
  for(const raw of String((env && env.TURNSTILE_HOSTNAMES) || "").split(",")){
    const host = String(raw).trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
    if(host) set.add(host);
  }
  if(!set.size) for(const host of TURNSTILE_HOSTNAMES_DEFAULT) set.add(host);
  return set;
}
/* Shape check only, so a garbage token never costs a Siteverify round trip. */
function turnstileTokenShape(token){
  if(typeof token !== "string") return false;
  const t = token.trim();
  if(t.length < TURNSTILE_MIN_TOKEN || t.length > TURNSTILE_MAX_TOKEN) return false;
  return /^[A-Za-z0-9._~-]+$/.test(t);
}
async function sha256Hex(text){
  const digest = await crypto.subtle.digest("SHA-256", utf8(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* Single-use guard: only SHA-256 hashes are held (never the token itself) and
   only for as long as a token could still be alive. Cloudflare rejects a
   replay on its own side as well - this just avoids the API call. */
const TURNSTILE_USED = new Map();
function turnstileAlreadyUsed(hash){
  const now = Date.now();
  for(const pair of TURNSTILE_USED){ if(pair[1] <= now) TURNSTILE_USED.delete(pair[0]); }
  return TURNSTILE_USED.has(hash);
}
function turnstileMarkUsed(hash){
  if(!hash) return;
  TURNSTILE_USED.set(hash, Date.now() + TURNSTILE_TTL_MS);
  if(TURNSTILE_USED.size > 20000) TURNSTILE_USED.clear();
}
/* Security log line. Only the event, the route, the client IP and stable codes
   are written - never the token, the secret, an ID token, a password or a
   payment credential. */
function securityLog(event, request, detail){
  try {
    console.warn("TICKETHUB_SECURITY", JSON.stringify(Object.assign({
      event: event, path: new URL(request.url).pathname, ip: clientIp(request)
    }, detail || {})));
  } catch(e){ /* logging must never break a request */ }
}
let turnstileWarned = false;

/* Verification is returned as data (never thrown) so each route can answer with
   the right status: 400 malformed token, 403 refused, 503 Siteverify down. */
async function turnstileVerify(env, token, ip, expectedAction){
  const secret = turnstileSecret(env);
  if(!secret){
    /* No secret configured: the deployment has not enabled Turnstile. This is a
       deliberate configuration state (local dev / staging), not a bypass of a
       half-finished check - set TURNSTILE_SECRET to switch enforcement on. */
    if(!turnstileWarned){ turnstileWarned = true; console.warn("TICKETHUB_SECURITY", JSON.stringify({ event: "turnstile_not_configured" })); }
    return { ok: true, skipped: true };
  }
  const testSecret = turnstileTestSecret(secret);
  if(!turnstileTokenShape(token)){
    return { ok: false, status: 400, code: "TURNSTILE_TOKEN_INVALID",
      message: "The bot protection check is missing or malformed. Please reload the page and try again." };
  }
  const trimmed = token.trim();
  let hash = "";
  try { hash = await sha256Hex(trimmed); } catch(e){ hash = ""; }
  if(!testSecret && hash && turnstileAlreadyUsed(hash)){
    return { ok: false, status: 403, code: "TURNSTILE_TOKEN_REUSED",
      message: "That bot protection check has already been used. Please complete it again." };
  }
  const form = new URLSearchParams({ secret: secret, response: trimmed });
  if(ip) form.set("remoteip", ip);
  let res = null, out = null;
  try {
    form.set("idempotency_key", crypto.randomUUID());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
    try {
      res = await fetch(TURNSTILE_ENDPOINT, { method: "POST", body: form, signal: controller.signal });
    } finally { clearTimeout(timer); }
    if(res && res.ok) out = await res.json();
  } catch(e){
    console.error("TICKETHUB_TURNSTILE", "siteverify_unreachable", String((e && e.message) || e));
    return { ok: false, status: 503, code: "TURNSTILE_UNAVAILABLE",
      message: "The bot protection service is unavailable right now. Please try again in a moment." };
  }
  if(!res || !res.ok || !out){
    /* A 4xx here means the SECRET itself is wrong or malformed (Cloudflare
       rejects it outright), a 5xx/timeout means Cloudflare is unavailable.
       Both fail the action safely; only the log differs, so an operator can
       tell a misconfiguration from an outage. */
    const cfg = res && res.status >= 400 && res.status < 500;
    console.error("TICKETHUB_TURNSTILE", cfg ? "siteverify_rejected_secret" : "siteverify_unavailable", String((res && res.status) || 0));
    return { ok: false, status: 503, code: "TURNSTILE_UNAVAILABLE",
      message: "The bot protection service is unavailable right now. Please try again in a moment." };
  }
  const codes = Array.isArray(out["error-codes"]) ? out["error-codes"] : [];
  if(out.success !== true){
    if(codes.indexOf("timeout-or-duplicate") > -1){
      /* Expired (older than 300s) or already redeemed: Cloudflare answers the
         same code for both. Either way that token is dead - ask for a new one.
         A dummy secret is exempt: its token is the same constant string every
         time, so remembering it would block every later development request. */
      if(!testSecret) turnstileMarkUsed(hash);
      return { ok: false, status: 403, code: "TURNSTILE_TOKEN_REUSED",
        message: "That bot protection check has expired or was already used. Please complete it again." };
    }
    return { ok: false, status: 403, code: "TURNSTILE_TOKEN_INVALID",
      message: "The bot protection check did not pass. Please complete it again.", cloudflare_codes: codes };
  }
  if(!testSecret){
    const hostname = String(out.hostname || "").toLowerCase();
    if(!turnstileHostnames(env).has(hostname)){
      return { ok: false, status: 403, code: "TURNSTILE_HOSTNAME",
        message: "The bot protection check was not completed on this website. Please reload the page and try again.",
        hostname: hostname };
    }
    if(expectedAction){
      const reported = String(out.action || "");
      if(reported !== expectedAction){
        return { ok: false, status: 403, code: "TURNSTILE_ACTION",
          message: "The bot protection check was completed for a different action. Please reload the page and try again.",
          action: reported };
      }
    }
    turnstileMarkUsed(hash);
  }
  return { ok: true, hostname: out.hostname || null, action: out.action || null };
}

/* The route gate. Call it before the handler does any work: it either returns a
   successful verification or throws the ApiError the caller's request deserves. */
async function requireTurnstile(env, request, body, action){
  const token = (body && typeof body === "object") ? body.turnstile_token : "";
  const result = await turnstileVerify(env, token, clientIp(request), action);
  if(result.ok) return result;
  securityLog("turnstile_rejected", request, {
    action: action, code: result.code, status: result.status,
    cloudflare_codes: result.cloudflare_codes || null,
    hostname: result.hostname || null, reported_action: result.action || null
  });
  throw err(result.status, result.message, result.code);
}

/* ------------------------------------------------- checkout authorisation ---
   A checkout is two calls: create the order, then ask the provider for a
   checkout URL. Turnstile tokens are single use, so the second call must not
   replay the first one's token. The order response therefore carries a
   short-lived receipt: an HMAC over the order reference, this client's IP and
   an expiry, keyed with the Turnstile secret. It authorises the payment step
   of that one order and expires with the token (5 minutes). A caller that has
   no receipt still has to solve a fresh challenge - the payment route accepts
   either, so it stays protected.
   The receipt is NOT an authentication credential: it is not tied to a user,
   it is not stored anywhere and it is not valid for anything else. */
async function checkoutIpKey(secret, ip){
  return (await hmacSha256Hex(secret, "turnstile-ip|" + String(ip || ""))).slice(0, 32);
}
async function checkoutProofIssue(env, reference, ip){
  const secret = turnstileSecret(env);
  if(!secret || !reference) return null;
  const exp = Date.now() + TURNSTILE_TTL_MS;
  const sig = await hmacSha256Hex(secret, "checkout-proof|" + reference + "|" + exp + "|" + await checkoutIpKey(secret, ip));
  return "p1." + exp + "." + sig;
}
async function checkoutProofValid(env, proof, reference, ip){
  const secret = turnstileSecret(env);
  if(!secret || !reference) return false;
  const m = /^p1\.(\d{10,16})\.([0-9a-f]{64})$/.exec(String(proof || ""));
  if(!m) return false;
  const exp = Number(m[1]), now = Date.now();
  if(!Number.isFinite(exp) || exp < now || exp > now + TURNSTILE_TTL_MS + 60000) return false;
  const expected = await hmacSha256Hex(secret, "checkout-proof|" + reference + "|" + exp + "|" + await checkoutIpKey(secret, ip));
  return safeEqual(expected, m[2]);
}

/* ------------------------------------------------------------ d1 utils ----- */
async function dbAll(env, sql, params){ const r = await env.DB.prepare(sql).bind(...(params||[])).all(); return (r && r.results) || []; }
async function dbGet(env, sql, params){ const rows = await dbAll(env, sql, params); return rows[0] || null; }
async function dbRun(env, sql, params){ return env.DB.prepare(sql).bind(...(params||[])).run(); }
function touch(){ return new Date().toISOString().replace("T"," ").slice(0,19); }
/* Timestamps stay UTC (touch() above, and SQLite's datetime('now') defaults):
   UTC is what keeps stored values sortable and comparable. "What day is it" is
   a Kenya question, not a UTC one, so every business-date decision - sales
   windows, the public event filters, the dashboards' "today" - is made on the
   Nairobi calendar. Kenya is UTC+3 all year round (no DST). */
const KE_OFFSET_MIN = 180;
function keShift(date){ return new Date((date ? date.getTime() : Date.now()) + KE_OFFSET_MIN * 60000); }
function keToday(date){ return keShift(date).toISOString().slice(0, 10); }
function paginate(url){
  const q = url.searchParams;
  let page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
  let limit = Math.min(100, Math.max(1, parseInt(q.get("limit") || "20", 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}
function metaOf(url, total){ const p = paginate(url); return { page: p.page, limit: p.limit, total: total == null ? null : Number(total) }; }

/* --------------------------------------------------- auth + authorization --- */
async function bearerToken(request){
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
/* Verifies the Firebase ID token and maps it to the D1 user. A Firebase user
   with no D1 row is auto-provisioned as a plain 'organizer' with status
   'active' but NO organizer business record and NO elevated rights; owners and
   staff are ONLY ever determined by existing D1 rows. */
async function authUser(env, request){
  const token = await bearerToken(request);
  if(!token) throw err(401, "Please sign in to continue.", "UNAUTHENTICATED");
  const ident = await verifyFirebaseToken(env, token);
  let user = await dbGet(env, "SELECT * FROM users WHERE firebase_uid = ?", [ident.uid]);
  if(!user){
    if(!ident.email) throw err(403, "Your account has no email address. Contact support.", "NO_EMAIL");
    const existing = await dbGet(env, "SELECT * FROM users WHERE email = ?", [ident.email]);
    if(existing){
      await dbRun(env, "UPDATE users SET firebase_uid = ?, updated_at = ? WHERE id = ?", [ident.uid, touch(), existing.id]);
      user = await dbGet(env, "SELECT * FROM users WHERE id = ?", [existing.id]);
    } else {
      const name = ident.name || (ident.email.split("@")[0] || "Organizer");
      /* 5 columns -> 5 placeholders: role = "organizer", status = "active". A
         hard-coded literal in that position would land in `status` (which the
         schema constrains to active/suspended/deleted) and leave the last
         binding unused, so D1 rejects the statement. */
      await dbRun(env, "INSERT INTO users (firebase_uid, full_name, email, role, status) VALUES (?,?,?,?,?)", [ident.uid, name, ident.email, "organizer", "active"]);
      user = await dbGet(env, "SELECT * FROM users WHERE firebase_uid = ?", [ident.uid]);
    }
  }
  if(user.status !== "active") throw err(403, "This account is not active. Contact support.", "ACCOUNT_INACTIVE");
  return { user, ident };
}
async function requireAuth(env, request){
  const { user, ident } = await authUser(env, request);
  return { user, ident };
}
async function organizerOf(env, user){
  const org = await dbGet(env, "SELECT * FROM organizers WHERE user_id = ?", [user.id]);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  if(org.status !== "active") throw err(403, "This organizer account is not active.", "ORGANIZER_INACTIVE");
  return org;
}
async function requireOrganizer(env, request){
  const { user, ident } = await requireAuth(env, request);
  if(user.role === "owner"){
    const org = await dbGet(env, "SELECT * FROM organizers WHERE user_id = ?", [user.id]);
    if(org) return { user, ident, org };
    throw err(403, "Owner accounts use the platform administration area.", "OWNER_NO_ORGANIZER");
  }
  if(user.role !== "organizer" && user.role !== "event_staff") throw err(403, "You do not have organizer access.", "FORBIDDEN");
  const org = await organizerOf(env, user);
  return { user, ident, org };
}
async function requireOwner(env, request){
  const { user, ident } = await requireAuth(env, request);
  if(user.role !== "owner") throw err(403, "Owner access required.", "FORBIDDEN");
  return { user, ident };
}
/* Event access: organizer owns it; owner manages all; staff needs mapping. */
async function eventAccess(env, user, eventId, needWrite){
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [eventId]);
  if(!ev) throw err(404, "Event not found.", "NOT_FOUND");
  if(user.role === "owner") return ev;
  if(user.role === "organizer"){
    const org = await dbGet(env, "SELECT id FROM organizers WHERE user_id = ?", [user.id]);
    if(org && org.id === ev.organizer_id) return ev;
  }
  if(!needWrite && user.role === "event_staff"){
    const st = await dbGet(env, "SELECT id FROM event_staff WHERE user_id = ? AND event_id = ?", [user.id, ev.id]);
    if(st) return ev;
  }
  throw err(403, "You do not have access to this event.", "FORBIDDEN");
}
function mePayload(user, org){
  return { user: { id: user.id, firebase_uid: user.firebase_uid, full_name: user.full_name, email: user.email, phone: user.phone, role: user.role, status: user.status }, organizer: org ? { id: org.id, business_name: org.business_name, business_email: org.business_email, business_phone: org.business_phone, logo_url: org.logo_url, status: org.status, use_owner_payments: Number(org.use_owner_payments) === 1 } : null };
}

/* --------------------------------------------------------- validation ------ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function vStr(v, name, opts){
  const o = opts || {}; let s = (v == null ? "" : String(v)).trim();
  if(o.max && s.length > o.max) s = s.slice(0, o.max);
  if(o.required && !s) throw err(422, (o.label || name) + " is required.", "VALIDATION");
  if(o.min && s && s.length < o.min) throw err(422, (o.label || name) + " is too short.", "VALIDATION");
  return s;
}
function vEmail(v, name, required){ const s = vStr(v, name, { max: 190 }); if((required || s) && !EMAIL_RE.test(s)) throw err(422, "Enter a valid " + (name || "email") + ".", "VALIDATION"); return s || null; }
function vPhone(v, name, required){ const s = vStr(v, name, { max: 32 }); if((required || s) && s.replace(/[^0-9]/g, "").length < 9) throw err(422, "Enter a valid phone number.", "VALIDATION"); return s || null; }
function vInt(v, name, opts){
  const o = opts || {}; const n = Number(v);
  if(!Number.isFinite(n) || !Number.isInteger(n)) throw err(422, (o.label || name) + " must be a whole number.", "VALIDATION");
  if(o.min != null && n < o.min) throw err(422, (o.label || name) + " must be at least " + o.min + ".", "VALIDATION");
  return n;
}
function vDate(v, name, required){ const s = vStr(v, name, { max: 10 }); if((required || s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw err(422, (name || "Date") + " must be YYYY-MM-DD.", "VALIDATION"); return s || null; }
function vTime(v, name){ const s = vStr(v, name, { max: 8 }); if(s && !/^\d{2}:\d{2}(:\d{2})?$/.test(s)) throw err(422, (name || "Time") + " must be HH:MM.", "VALIDATION"); return s ? s.slice(0,5) : null; }
function vEnum(v, list, name, dflt){ const s = vStr(v, name, { max: 24 }) || dflt; if(!list.includes(s)) throw err(422, "Invalid " + name + ".", "VALIDATION"); return s; }
async function readJson(request){
  try { const b = await request.json(); return (b && typeof b === "object" && !Array.isArray(b)) ? b : {}; }
  catch(e){ throw err(400, "Invalid request body.", "BAD_JSON"); }
}
function slugify(title, suffix){
  const base = String(title || "event").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "event";
  return suffix ? base + "-" + String(suffix).toLowerCase() : base;
}
/* Order/ticket numbers are public identifiers, so they use a 10-character
   random suffix: short enough to read out at a gate, long enough that an
   order or ticket cannot be guessed by enumeration. */
const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(len){
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for(const b of buf) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}
function orderNumber(){ return "PAT-" + randomCode(10); }
function ticketNumber(){ return "PAT-" + randomCode(10); }
const esc = s => String(s == null ? "" : s).replace(/[&<>\"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/* ------------------------------------------------------ event pub shape ---- */
function publicEvent(ev){
  return { id: ev.id, title: ev.title, slug: ev.slug, description: ev.description, category: ev.category,
    venue: ev.venue, location: ev.location, event_date: ev.event_date, start_time: ev.start_time, end_time: ev.end_time,
    poster_url: ev.poster_url, status: ev.status, is_featured: !!ev.is_featured, sales_start: ev.sales_start, sales_end: ev.sales_end,
    organizer_name: ev.organizer_name || null, created_at: ev.created_at,
    /* Which gateway the buyer will be sent to, and whether the money is collected
       by the organizer's own account or the platform owner's. */
    payment_provider: ev.payment_provider || null,
    payment_mode: ev.payment_mode || null };
}
function publicTicketType(t){
  const available = Math.max(0, Number(t.quantity) - Number(t.sold));
  return { id: t.id, event_id: t.event_id, name: t.name, description: t.description, price: Number(t.price),
    quantity: Number(t.quantity), sold: Number(t.sold), available, sales_start: t.sales_start, sales_end: t.sales_end,
    status: t.status, on_sale: ticketOnSale(t) };
}
function ticketOnSale(t, todayKenya){
  /* The sale window is stored as the Kenyan wall clock the organizer typed, so
     only the date part matters and it is compared with the Kenyan day. */
  const today = String(todayKenya || keToday()).slice(0, 10);
  if(String(t.status) !== "active") return false;
  if(Number(t.quantity) - Number(t.sold) <= 0) return false;
  if(t.sales_start && String(t.sales_start).slice(0,10) > today) return false;
  if(t.sales_end && String(t.sales_end).slice(0,10) < today) return false;
  return true;
}

/* ============================================================================
   RATE LIMITING  (server-side, before any protected work)
   ----------------------------------------------------------------------------
   One policy table, one enforcement path, up to three tiers per request:
     1. memory  - per-isolate fixed window; free, so a flood is rejected before
                  any D1 round trip.
     2. binding - Cloudflare's native Rate Limiting binding when one is bound as
                  `RATE_LIMITER` (see wrangler.toml). Native, writes no rows.
     3. D1      - the authoritative cross-isolate counter: one row per identity
                  per window, keyed by the window start, expired rows swept.

   ATOMICITY: the D1 tier never reads-then-writes. It issues ONE `INSERT ...
   ON CONFLICT DO UPDATE` (a single atomic statement) plus a `SELECT`, both
   inside `env.DB.batch()`, which D1 runs as one transaction. Two concurrent
   requests therefore cannot both act on the same pre-increment count, and the
   counter is capped at limit+1 so a flood cannot make the row grow unbounded.

   PRIVACY: no raw identity reaches D1 - `rate_key` is sha256(identity|window).
   Email identities are hashed before they even reach the memory map. Logs carry
   the action, tier, source and a short key hash: never an address, token or key.

   NOT LIMITED HERE (deliberately): public event browsing, event pages,
   categories, media/posters and every payment callback/webhook. Broad traffic
   shaping belongs in Cloudflare's WAF / rate-limiting rules instead.
   ========================================================================== */
const RATE_MEMORY_MAX_KEYS = 20000;
const RATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;   // expired-row cleanup cadence
const RATE_SWEEP_PROBABILITY = 0.02;            // + the cron trigger, every run
/* Every action the Worker rate limits, in one place. No route hard-codes a
   number: `guardRate(env, request, "<action>", {...})` is the only call sites
   use. store:"d1" makes a tier authoritative across isolates; store:"memory"
   keeps it free and per-isolate. Each tier can be overridden per environment
   with <ACTION>_LIMIT / <ACTION>_WINDOW, and the extra tiers with
   <ACTION>_<TIER>_LIMIT / <ACTION>_<TIER>_WINDOW (see envRateNumber). */
const RATE_POLICIES = {
  /* ---- public authentication surfaces (identity shaped, abuse-prone) ---- */
  login:          { tiers: [ { by: "ip", limit: 5, window: 900, store: "d1" },
                             { by: "email", limit: 10, window: 900, store: "d1" } ] },
  password_reset: { tiers: [ { by: "email", limit: 3, window: 3600, store: "d1" },
                             { by: "ip", limit: 5, window: 3600, store: "d1" } ] },
  otp:            { tiers: [ { by: "email", limit: 3, window: 3600, store: "d1" },
                             { by: "ip", limit: 5, window: 3600, store: "d1" } ] },
  register:       { tiers: [ { by: "ip", limit: 5, window: 3600, store: "d1" } ] },
  /* ---- free ticket verification (Email OTP + IP abuse prevention) ----------
     These are the GLOBAL defaults. The free-ticket routes resolve the effective
     numbers in freeTierLimit() (event override, then env var, then this), and
     enforce them through rateLimit() directly, so a per-event override really
     changes the enforced number. They are listed here so the policy surface is
     in one place and GET /api/health counts them. */
  free_otp:       { tiers: [ { by: "ip", limit: 5, window: 900, store: "d1" },
                             { by: "email", limit: 5, window: 3600, store: "d1" } ] },
  free_verify:    { tiers: [ { by: "ip", limit: 15, window: 900, store: "d1" } ] },
  free_register:  { tiers: [ { by: "ip", limit: 10, window: 900, store: "d1" } ] },
  /* ---- public buying flow ---- */
  checkout:       { tiers: [ { by: "ip", limit: 10, window: 600, store: "d1" },
                             { by: "ref", limit: 5, window: 600, store: "d1" } ] },
  contact:        { tiers: [ { by: "ip", limit: 5, window: 3600, store: "d1" },
                             { by: "email", limit: 3, window: 3600, store: "d1" } ] },
  ticket_email:   { tiers: [ { by: "ip", limit: 5, window: 600, store: "d1" },
                             { by: "ref", limit: 5, window: 600, store: "d1" },
                             { by: "email", limit: 5, window: 3600, store: "d1" } ] },
  /* ---- authenticated organizer / staff writes ---- */
  event_create:   { tiers: [ { by: "user", limit: 10, window: 3600, store: "d1" },
                             { by: "ip", limit: 60, window: 3600, store: "d1" } ] },
  /* The agreement signing surface. The per-user tier stops a session from
     hammering the single-use link; the per-IP tier stops a script from probing
     tokens across accounts. Both tiers are D1-backed, so rotating isolates
     does not reset them. */
  agreement_invite: { tiers: [ { by: "user", limit: 8, window: 3600, store: "d1" },
                               { by: "ip", limit: 30, window: 3600, store: "d1" } ] },
  agreement_sign:   { tiers: [ { by: "user", limit: 15, window: 3600, store: "d1" },
                               { by: "ip", limit: 40, window: 3600, store: "d1" } ] },
  /* A scanner validates many DIFFERENT tickets at a gate, so the per-minute
     number stays generous; the hourly tier is what stops a stolen session from
     walking every ticket number in the database. */
  checkin:        { tiers: [ { by: "user", limit: 300, window: 60, store: "d1" },
                             { by: "user", limit: 6000, window: 3600, store: "d1" },
                             { by: "ip", limit: 600, window: 60, store: "d1" } ] },
  /* Owner-triggered mail: a compromised owner session must not be able to loop
     real messages out of the Brevo account. */
  owner_email:    { tiers: [ { by: "user", limit: 30, window: 600, store: "d1" },
                             { by: "ip", limit: 60, window: 600, store: "d1" } ] },
  /* ---- the remaining abuse-prone reads/writes: cheap per-isolate nets, with
     one exception - order_lookup below is D1-backed (see its own note). ---- */
  payment_status: { tiers: [ { by: "ip", limit: 60, window: 60, store: "memory" } ] },
  order_tickets:  { tiers: [ { by: "ip", limit: 40, window: 60, store: "memory" } ] },
  /* The email-verified read behind /check-ticket/: the caller must name the
     address the order was placed with, so guessing one half against the other
     is the abuse these tiers are for. All three are D1-backed: a search is the
     one public read a bot can point at the order table, and a per-isolate
     counter would hand it a fresh allowance on every new isolate. */
  order_lookup:   { tiers: [ { by: "ip", limit: 20, window: 60, store: "d1" },
                             { by: "ip", limit: 120, window: 3600, store: "d1" },
                             { by: "email", limit: 10, window: 600, store: "d1" } ] },
  order_detail:   { tiers: [ { by: "ip", limit: 60, window: 60, store: "memory" } ] },
  ticket_lookup:  { tiers: [ { by: "ip", limit: 60, window: 60, store: "memory" } ] },
  ticket_qr:      { tiers: [ { by: "ip", limit: 120, window: 60, store: "memory" } ] },
  poster:         { tiers: [ { by: "ip", limit: 20, window: 600, store: "memory" } ] },
  logo:           { tiers: [ { by: "ip", limit: 20, window: 600, store: "memory" } ] },
  ticket_type:    { tiers: [ { by: "ip", limit: 60, window: 60, store: "memory" } ] },
  payment_settings:{ tiers: [ { by: "ip", limit: 30, window: 600, store: "memory" } ] },
  payment_test:   { tiers: [ { by: "ip", limit: 20, window: 600, store: "memory" } ] },
  /* Owner-triggered payment reconcile: re-verifies ONE failed/pending order
     with the provider. Capped per owner account + per IP so a hijacked owner
     session cannot hammer the provider APIs. */
  owner_reconcile: { tiers: [ { by: "user", limit: 30, window: 600, store: "d1" },
                               { by: "ip", limit: 60, window: 600, store: "d1" } ] },
  /* ---- the challenge endpoint behind the browser-side Firebase flows ---- */
  turnstile_auth: { tiers: [ { by: "ip", limit: 20, window: 600, store: "d1" } ] }
};
/* Which security event a refusal is logged under. */
const RATE_EVENTS = {
  login: "SUSPICIOUS_AUTH_ACTIVITY", password_reset: "EXCESSIVE_PASSWORD_RESET_REQUESTS",
  otp: "EXCESSIVE_VERIFICATION_REQUESTS", register: "EXCESSIVE_REGISTRATION_ATTEMPTS",
  checkout: "EXCESSIVE_CHECKOUT_ATTEMPTS", contact: "EXCESSIVE_CONTACT_SUBMISSIONS",
  ticket_email: "EXCESSIVE_TICKET_EMAIL_REQUESTS", event_create: "EXCESSIVE_EVENT_CREATION",
  free_otp: "EXCESSIVE_FREE_TICKET_OTP_REQUESTS", free_verify: "EXCESSIVE_FREE_TICKET_OTP_ATTEMPTS",
  free_register: "EXCESSIVE_FREE_TICKET_REGISTRATIONS",
  checkin: "EXCESSIVE_CHECKIN_ATTEMPTS", owner_email: "EXCESSIVE_OWNER_EMAIL_SENDS",
  order_lookup: "EXCESSIVE_ORDER_LOOKUP_ATTEMPTS"
};
function rateEventFor(action){ return RATE_EVENTS[action] || "RATE_LIMIT_EXCEEDED"; }
/* Best-effort in-memory limiter per isolate. Cloudflare's native WAF/rate
   rules remain the authoritative production control. */
/* --- tier 1: per-isolate memory window ----------------------------------- */
const RATE = new Map();
function memoryBump(key, limit, resetAt){
  const now = Date.now();
  let slot = RATE.get(key);
  if(!slot || now >= slot.resetAt){ slot = { count: 0, resetAt: resetAt }; }
  slot.count++;
  RATE.set(key, slot);
  if(RATE.size > RATE_MEMORY_MAX_KEYS) RATE.clear();
  return slot.count;
}
function memoryReset(key){ RATE.delete(key); }

/* --- tier 3: D1 window counter (authoritative across isolates) -------------
   The key is bucketed by the window start, so a window is ONE row no matter how
   many requests arrive, and the row expires by itself once the window ends. */
const RATE_UPSERT_SQL =
  "INSERT INTO rate_limits (rate_key, action, window_start, request_count, expires_at, updated_at) " +
  "VALUES (?,?,?,1,?,?) ON CONFLICT(rate_key) DO UPDATE SET " +
  "request_count = MIN(rate_limits.request_count + 1, ?), updated_at = ?";
const RATE_READ_SQL = "SELECT request_count, expires_at FROM rate_limits WHERE rate_key = ?";
let rateStoreState = "unknown";     // d1 | binding | memory | degraded
let rateStoreWarned = false;
let rateLastSweep = 0;
async function d1Bump(env, key, action, windowStart, windowMs, limit){
  if(!env || !env.DB) return { degraded: "no_db" };
  const now = Date.now();
  const rateKey = await sha256Hex(key + "|" + windowStart);
  const expiresAt = windowStart + windowMs;
  try {
    const out = await env.DB.batch([
      env.DB.prepare(RATE_UPSERT_SQL).bind(rateKey, action, windowStart, expiresAt, now, limit + 1, now),
      env.DB.prepare(RATE_READ_SQL).bind(rateKey)
    ]);
    const rows = (out && out[1] && out[1].results) || [];
    const used = rows.length ? Number(rows[0].request_count) : 1;
    if(rateStoreState !== "d1") rateStoreState = "d1";
    if(Math.random() < RATE_SWEEP_PROBABILITY) await rateSweep(env, false);
    return { used: used, expiresAt: expiresAt, rateKey: rateKey };
  } catch(e){
    /* A missing table (migration not run yet) or a D1 blip must not take the
       site down: the memory tier has already counted this request, so the
       worst case is a per-isolate limit until D1 recovers. */
    rateStoreWarn("d1_unavailable", String((e && e.message) || e));
    return { degraded: "d1_error" };
  }
}
function rateStoreWarn(reason, detail){
  rateStoreState = "degraded";
  if(rateStoreWarned) return;
  rateStoreWarned = true;
  console.error("RATE_LIMIT_STORE", reason, detail || "");
}
/* Removes windows that can no longer be counted: indexed by expires_at, at most
   once per isolate per RATE_SWEEP_INTERVAL_MS, plus every cron tick. Rows live
   for one window, never forever. The cutoff is the window end itself - a new
   window is a new key, so there is nothing to protect by waiting, and clock skew
   between isolates can at worst allow a couple of extra requests in a window
   that has already ended. */
async function rateSweep(env, force){
  const now = Date.now();
  if(!force && now - rateLastSweep < RATE_SWEEP_INTERVAL_MS) return { skipped: true };
  if(!env || !env.DB) return { skipped: true };
  rateLastSweep = now;
  try {
    const res = await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now).run();
    return { deleted: (res && res.meta && Number(res.meta.changes)) || 0 };
  } catch(e){
    rateStoreWarn("sweep_failed", String((e && e.message) || e));
    return { error: true };
  }
}
/* --- tier 2: Cloudflare native Rate Limiting binding, when one is bound ----- */
async function bindingBump(env, key){
  const binding = env && env.RATE_LIMITER;
  if(!binding || typeof binding.limit !== "function") return null;
  try {
    const out = await binding.limit({ key: key });
    if(rateStoreState !== "binding") rateStoreState = "binding";
    return { allowed: !(out && out.success === false), expiresAt: (out && out.reset) || 0 };
  } catch(e){
    console.error("RATE_LIMIT_BINDING", "error", String((e && e.message) || e));
    return null;
  }
}

/* ============================================================================
   THE LIMITER
   ----------------------------------------------------------------------------
   rateLimit() is the single enforcement primitive. It never returns a "maybe":
   either the request is counted inside the limit and `{ ok:true, ... }` comes
   back, or it throws a 429 ApiError carrying Retry-After.

     await rateLimit({ key, limit, windowSeconds, action, store })
   ========================================================================== */
async function rateLimit(o){
  const key = String((o && o.key) || "anon");
  const limit = Math.max(1, Math.floor(Number(o && o.limit) || 1));
  const windowSeconds = Math.max(1, Math.floor(Number(o && o.windowSeconds) || 60));
  const action = String((o && o.action) || "unknown");
  const store = String((o && o.store) || "memory");
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  /* 1. memory: free, immediate, and enough to stop a single-isolate flood. The
     slot is bucketed by the window length as well as by the identity, so an
     action with two tiers on ONE identity (checkin: per minute + per hour,
     order_lookup: per minute + per hour per IP) keeps one counter per window
     instead of sharing a single counter and charging every request twice -
     which is what the D1 tier already does with window_start. */
  const usedMemory = memoryBump(key + "|" + windowMs, limit, resetAt);
  if(usedMemory > limit) throw rateExceeded(action, key, limit, resetAt, "memory");

  /* 2. Cloudflare native binding, when the Worker has one bound. */
  if(store !== "memory"){
    const native = await bindingBump(o.env, key);
    if(native && !native.allowed) throw rateExceeded(action, key, limit, (native.expiresAt || resetAt), "binding");
  }

  /* 3. D1: the counter that every isolate shares. */
  if(store === "d1"){
    const stored = await d1Bump(o.env, key, action, windowStart, windowMs, limit);
    if(!stored.degraded && stored.used > limit) throw rateExceeded(action, key, limit, (stored.expiresAt || resetAt), "d1");
  }
  return { ok: true, action: action, limit: limit, used: usedMemory,
    remaining: Math.max(0, limit - usedMemory), resetAt: resetAt, store: store };
}

/* Builds the 429. The message is deliberately vague about WHICH limit was hit
   (a user must not be able to probe the thresholds), but it always says when
   they may try again. The caller (guardRate) adds the security log line. */
function rateExceeded(action, key, limit, resetAt, source){
  const retryAfter = Math.max(1, Math.ceil((Number(resetAt) - Date.now()) / 1000));
  const wait = retryAfter >= 120 ? (Math.round(retryAfter / 60) + " minutes") : (retryAfter + " seconds");
  const e = err(429, "Too many requests. Please try again in about " + wait + ".", "RATE_LIMITED");
  e.retryAfter = retryAfter;
  e.rateAction = action;
  e.rateTier = String(key || "").split(":")[0] || "unknown";
  e.rateLimit = limit;
  e.rateSource = source;
  return e;
}

/* --- identities ------------------------------------------------------------ */
/* Cloudflare sets CF-Connecting-IP and overwrites anything the client sent, so
   it is the only header trusted here. X-Forwarded-For is a last-resort fallback
   for local testing; it is the FIRST value in the list, which is the one a
   client could have forged, so it is deliberately not preferred. */
function clientIp(request){
  const cf = (request.headers.get("CF-Connecting-IP") || "").trim();
  if(cf) return cf;
  const xff = (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim();
  return xff || "unknown";
}
/* Emails are compared case-insensitively and trimmed before they become a key,
   so "  Jane@Example.COM " and "jane@example.com" share one bucket. */
function normaliseEmail(value){
  return String(value == null ? "" : value).trim().toLowerCase();
}
/* Firebase UID taken from the Authorization header WITHOUT touching D1: this
   proves identity for a per-user limit but never creates a user row, so an
   unauthenticated flood cannot provision accounts. Failures are swallowed -
   the route's own requireAuth() still answers 401. */
async function callerUid(env, request){
  const token = await bearerToken(request);
  if(!token) return "";
  try { const ident = await verifyFirebaseToken(env, token); return (ident && ident.uid) || ""; }
  catch(e){ return ""; }
}

/* --- policy resolution ----------------------------------------------------- */
function envRateNumber(env, name, dflt){
  const raw = env ? env[name] : undefined;
  const n = Number(raw);
  return (raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0) ? Math.floor(n) : dflt;
}
/* Resolves an action into its tiers, applying the per-environment overrides:
     <ACTION>_LIMIT / <ACTION>_WINDOW            -> the first tier
     <ACTION>_<TIER>_LIMIT / <ACTION>_<TIER>_WINDOW -> the rest */
function rateTiers(env, action){
  const policy = RATE_POLICIES[action];
  if(!policy || !Array.isArray(policy.tiers)) return [];
  const prefix = String(action).toUpperCase();
  return policy.tiers.map(function(tier, index){
    const suffix = index === 0 ? "" : ("_" + String(tier.by || "").toUpperCase());
    const base = "RATE_" + prefix + suffix;
    return {
      by: tier.by,
      store: tier.store || "memory",
      limit: envRateNumber(env, base + "_LIMIT", envRateNumber(env, prefix + suffix + "_LIMIT", tier.limit)),
      window: envRateNumber(env, base + "_WINDOW", envRateNumber(env, prefix + suffix + "_WINDOW", tier.window))
    };
  });
}
/* The one function routes call. Resolves the identities it has, runs every tier
   of the named action, and throws a logged 429 as soon as one tier is exhausted.
   Layering means an attacker has to beat several limits at once: rotating IPs
   still hits the email/user tier, and rotating emails still hits the IP tier. */
async function guardRate(env, request, action, opts){
  const o = opts || {};
  const tiers = rateTiers(env, action);
  if(!tiers.length) return null;
  const ip = clientIp(request);
  const email = normaliseEmail(o.email);
  const uid = String(o.uid || "");
  const ref = String(o.ref || "").trim().toUpperCase();
  const skip = Array.isArray(o.skip) ? o.skip : [];
  let last = null;
  for(const tier of tiers){
    if(skip.indexOf(tier.by) > -1) continue;               // staged tier, counted later
    let id = "";
    if(tier.by === "ip") id = ip;
    else if(tier.by === "user") id = uid;
    else if(tier.by === "email") id = email;
    else if(tier.by === "ref") id = ref;
    if(!id || id === "unknown") continue;             // no identity -> skip tier
    /* Emails are hashed here, so the address never reaches the memory map, the
       D1 key, or a log line. IPs and UIDs stay readable for operations; D1
       hashes them anyway. */
    const subject = tier.by === "email" ? ("h" + (await sha256Hex(id)).slice(0, 24)) : id;
    const key = tier.by + ":" + subject + ":" + action;
    try {
      last = await rateLimit({ env: env, key: key, limit: tier.limit,
        windowSeconds: tier.window, action: action, store: tier.store });
    } catch(e){
      if(e && e.rateAction){
        securityLog(rateEventFor(action), request, {
          action: action, tier: e.rateTier, limit: e.rateLimit, source: e.rateSource,
          store: tier.store, retry_after: e.retryAfter
        });
      }
      throw e;
    }
  }
  return last;
}

/* ------------------------------------------------ inventory housekeeping --- */
/* Unpaid orders older than the TTL release their reserved inventory. Runs on
   order creation and webhook paths; safe to run concurrently. */
async function releaseExpiredOrders(env){
  const cutoff = new Date(Date.now() - PENDING_ORDER_TTL_MIN * 60000).toISOString().replace("T"," ").slice(0,19);
  const stale = await dbAll(env,
    "SELECT o.id, o.status FROM orders o WHERE o.status = \'pending\' AND o.created_at < ? LIMIT 50", [cutoff]);
  for(const o of stale){
    const items = await dbAll(env, "SELECT ticket_type_id, quantity FROM order_items WHERE order_id = ?", [o.id]);
    for(const it of items){
      await dbRun(env, "UPDATE ticket_types SET sold = MAX(0, sold - ?), updated_at = ? WHERE id = ?", [it.quantity, touch(), it.ticket_type_id]);
    }
    await dbRun(env, "UPDATE orders SET status = \'cancelled\', updated_at = ? WHERE id = ? AND status = \'pending\'", [touch(), o.id]);
    await dbRun(env, "UPDATE payments SET status = \'failed\', updated_at = ? WHERE order_id = ? AND status = \'pending\'", [touch(), o.id]);
    /* A cancelled registration releases any free-ticket slots it was holding, so
       an abandoned attempt does not consume a person's per-email limit. Guarded
       for a database that has not run migration 0006 yet. */
    try { await releaseFreeTicketClaims(env, o.id); } catch(e){ /* pre-0006 database */ }

  }
}
/* ============================================================================
   QR CODE ENCODER  (no dependencies)
   ----------------------------------------------------------------------------
   Byte mode, error correction level M, versions 1-10 -> real PNG bytes.
   Only the opaque tickets.qr_token is ever encoded, so a scanned code reveals
   nothing but an unguessable identifier that the Worker re-validates.
   ========================================================================== */
/* version -> [ecCodewordsPerBlock, [[blocks, dataCodewords], ...]] for level M */
const QR_SPEC = {
  1:  [10, [[1, 16]]],
  2:  [16, [[1, 28]]],
  3:  [26, [[1, 44]]],
  4:  [18, [[2, 32]]],
  5:  [24, [[2, 43]]],
  6:  [16, [[4, 27]]],
  7:  [18, [[4, 31]]],
  8:  [22, [[2, 38], [2, 39]]],
  9:  [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]]
};
const QR_ALIGN = { 1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30], 6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50] };

const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(function buildGaloisTables(){
  let x = 1;
  for(let i = 0; i < 255; i++){ GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if(x & 0x100) x ^= 0x11D; }
  for(let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b){ return (!a || !b) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }
/* Generator polynomial for n error-correction codewords, highest power first. */
function rsGenerator(n){
  let asc = [1];
  for(let i = 0; i < n; i++){
    const a = GF_EXP[i];
    const next = new Array(asc.length + 1).fill(0);
    for(let k = 0; k < asc.length; k++){ next[k] ^= gfMul(asc[k], a); next[k + 1] ^= asc[k]; }
    asc = next;
  }
  return asc.slice().reverse();
}
function rsEncode(data, ecLen){
  const gen = rsGenerator(ecLen);
  const buf = data.concat(new Array(ecLen).fill(0));
  for(let i = 0; i < data.length; i++){
    const coef = buf[i];
    if(!coef) continue;
    for(let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.slice(data.length);
}
function qrDataCapacity(version){
  let total = 0;
  for(const g of QR_SPEC[version][1]) total += g[0] * g[1];
  return total;
}
function qrVersionFor(len){
  for(let v = 1; v <= 10; v++){
    const header = 4 + (v <= 9 ? 8 : 16);
    if((qrDataCapacity(v) * 8) >= header + len * 8) return v;
  }
  throw err(500, "Ticket code is too long to encode.", "QR_TOO_LONG");
}
function qrCodewords(bytes, version){
  const bits = [];
  const push = (val, len) => { for(let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for(const b of bytes) push(b, 8);
  const capBytes = qrDataCapacity(version);
  const capBits = capBytes * 8;
  for(let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  while(bits.length % 8) bits.push(0);
  const out = [];
  for(let i = 0; i < bits.length; i += 8){
    let v = 0;
    for(let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  const pads = [0xEC, 0x11];
  let p = 0;
  while(out.length < capBytes) out.push(pads[(p++) % 2]);
  return out.slice(0, capBytes);
}
function qrInterleave(codewords, version){
  const spec = QR_SPEC[version], ecLen = spec[0];
  const blocks = [];
  let offset = 0;
  for(const grp of spec[1]){
    for(let b = 0; b < grp[0]; b++){
      const data = codewords.slice(offset, offset + grp[1]); offset += grp[1];
      blocks.push({ data: data, ec: rsEncode(data, ecLen) });
    }
  }
  const out = [];
  let maxData = 0;
  for(const b of blocks) if(b.data.length > maxData) maxData = b.data.length;
  for(let i = 0; i < maxData; i++) for(const b of blocks) if(i < b.data.length) out.push(b.data[i]);
  for(let i = 0; i < ecLen; i++) for(const b of blocks) out.push(b.ec[i]);
  return out;
}
function qrMaskBit(mask, r, c){
  switch(mask){
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}
function qrFormatBits(mask){
  const data = mask;                       // EC level M = 00 followed by 3 mask bits
  let d = data << 10;
  for(let i = 14; i >= 10; i--) if((d >>> i) & 1) d ^= 0x537 << (i - 10);
  return ((data << 10) | (d & 0x3FF)) ^ 0x5412;
}
function qrVersionBits(version){
  let d = version << 12;
  for(let i = 17; i >= 12; i--) if((d >>> i) & 1) d ^= 0x1F25 << (i - 12);
  return (version << 12) | (d & 0xFFF);
}
/* Builds one candidate module matrix (0 = light, 1 = dark) for a given mask. */
function qrBuildMatrix(version, codewords, mask){
  const size = version * 4 + 17;
  const m = [], reserved = [];
  for(let r = 0; r < size; r++){ m.push(new Array(size).fill(0)); reserved.push(new Array(size).fill(false)); }
  const set = (r, c, v) => { if(r >= 0 && r < size && c >= 0 && c < size){ m[r][c] = v ? 1 : 0; reserved[r][c] = true; } };
  const finder = (r0, c0) => {
    for(let r = -1; r <= 7; r++) for(let c = -1; c <= 7; c++){
      if(r0 + r < 0 || r0 + r >= size || c0 + c < 0 || c0 + c >= size) continue;
      const inside = (r >= 0 && r <= 6 && c >= 0 && c <= 6);
      const edge = (r === 0 || r === 6 || c === 0 || c === 6);
      const core = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      set(r0 + r, c0 + c, inside && (edge || core));
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  for(let i = 8; i < size - 8; i++){ set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for(const r of QR_ALIGN[version]) for(const c of QR_ALIGN[version]){
    if((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for(let dr = -2; dr <= 2; dr++) for(let dc = -2; dc <= 2; dc++)
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  for(let i = 0; i <= 8; i++){ set(8, i, 0); set(i, 8, 0); }
  for(let i = 0; i < 8; i++){ set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
  if(version >= 7){
    for(let br = 0; br < 6; br++) for(let bc = 0; bc < 3; bc++){
      set(br, size - 11 + bc, 0);
      set(size - 11 + bc, br, 0);
    }
  }
  let upward = true, row = size - 1, bit = 7, byteIdx = 0;
  for(let col = size - 1; col > 0; col -= 2){
    if(col === 6) col--;
    for(;;){
      for(let k = 0; k < 2; k++){
        const c = col - k;
        if(reserved[row][c]) continue;
        let dark = false;
        if(byteIdx < codewords.length) dark = ((codewords[byteIdx] >>> bit) & 1) === 1;
        if(qrMaskBit(mask, row, c)) dark = !dark;
        m[row][c] = dark ? 1 : 0;
        bit--;
        if(bit < 0){ byteIdx++; bit = 7; }
      }
      row += upward ? -1 : 1;
      if(row < 0 || row >= size){ row -= upward ? -1 : 1; upward = !upward; break; }
    }
  }
  const fmt = qrFormatBits(mask);
  for(let i = 0; i < 15; i++){
    const on = ((fmt >>> i) & 1) === 1;
    if(i < 6) m[i][8] = on ? 1 : 0;
    else if(i < 8) m[i + 1][8] = on ? 1 : 0;
    else m[size - 15 + i][8] = on ? 1 : 0;
    if(i < 8) m[8][size - i - 1] = on ? 1 : 0;
    else if(i < 9) m[8][15 - i] = on ? 1 : 0;
    else m[8][14 - i] = on ? 1 : 0;
  }
  m[size - 8][8] = 1;                       // dark module
  if(version >= 7){
    const vb = qrVersionBits(version);
    for(let i = 0; i < 18; i++){
      const on = ((vb >>> i) & 1) === 1;
      m[Math.floor(i / 3)][i % 3 + size - 11] = on ? 1 : 0;
      m[i % 3 + size - 11][Math.floor(i / 3)] = on ? 1 : 0;
    }
  }
  return m;
}
function qrHasPattern(seq, pat){
  for(let i = 0; i + pat.length <= seq.length; i++){
    let ok = true;
    for(let k = 0; k < pat.length; k++) if(seq[i + k] !== pat[k]){ ok = false; break; }
    if(ok) return true;
  }
  return false;
}
/* ISO/IEC 18004 penalty rules - the mask with the lowest score is used. */
function qrPenalty(m){
  const size = m.length;
  const P1 = [1,0,1,1,1,0,1,0,0,0,0], P2 = [0,0,0,0,1,0,1,1,1,0,1];
  let score = 0, dark = 0;
  for(let i = 0; i < size; i++){
    let runRow = 1, runCol = 1;
    for(let j = 1; j < size; j++){
      runRow = (m[i][j] === m[i][j - 1]) ? runRow + 1 : 1;
      if(runRow === 5) score += 3; else if(runRow > 5) score += 1;
      runCol = (m[j][i] === m[j - 1][i]) ? runCol + 1 : 1;
      if(runCol === 5) score += 3; else if(runCol > 5) score += 1;
    }
    const col = [];
    for(let j = 0; j < size; j++){ col.push(m[j][i]); dark += m[i][j]; }
    if(qrHasPattern(m[i], P1) || qrHasPattern(m[i], P2)) score += 40;
    if(qrHasPattern(col, P1) || qrHasPattern(col, P2)) score += 40;
  }
  for(let r = 0; r < size - 1; r++) for(let c = 0; c < size - 1; c++){
    const v = m[r][c];
    if(v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  const pct = (dark * 100) / (size * size);
  return score + Math.floor(Math.abs(pct - 50) / 5) * 10;
}
function qrModules(text){
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  const cw = qrInterleave(qrCodewords(bytes, version), version);
  let best = null, bestScore = Infinity;
  for(let mask = 0; mask < 8; mask++){
    const m = qrBuildMatrix(version, cw, mask);
    const s = qrPenalty(m);
    if(s < bestScore){ bestScore = s; best = m; }
  }
  return best;
}
/* --------------------------------------------------------- png encoder ----- */
/* Minimal PNG writer (8-bit grayscale) using stored (uncompressed) deflate
   blocks, so no compression library is needed and the bytes stay valid PNG. */
const CRC_TABLE = (function(){
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(bytes){
  let a = 1, b = 0;
  for(let i = 0; i < bytes.length; i++){ a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function concatBytes(parts){
  let len = 0;
  for(const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for(const p of parts){ out.set(p, at); at += p.length; }
  return out;
}
function zlibStored(data){
  const parts = [new Uint8Array([0x78, 0x01])];
  let offset = 0;
  do {
    const len = Math.min(65535, data.length - offset);
    const head = new Uint8Array(5);
    head[0] = (offset + len >= data.length) ? 1 : 0;         // BFINAL, stored block
    head[1] = len & 0xFF; head[2] = (len >>> 8) & 0xFF;
    const inv = (~len) & 0xFFFF;
    head[3] = inv & 0xFF; head[4] = (inv >>> 8) & 0xFF;
    parts.push(head, data.subarray(offset, offset + len));
    offset += len;
  } while(offset < data.length);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, adler32(data));
  parts.push(tail);
  return concatBytes(parts);
}
function pngChunk(type, data){
  const body = concatBytes([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(body.length + 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(body.length + 4, crc32(body));
  return out;
}
function pngGrayscale(width, height, pixels){
  const raw = new Uint8Array((width + 1) * height);
  for(let y = 0; y < height; y++){
    raw[y * (width + 1)] = 0;                                // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array(0))
  ]);
}
function qrPngBytes(text){
  const m = qrModules(text);
  const size = m.length;
  const quiet = 4;
  const scale = size <= 25 ? 8 : (size <= 41 ? 7 : 6);
  const dim = (size + quiet * 2) * scale;
  const px = new Uint8Array(dim * dim).fill(255);
  for(let r = 0; r < size; r++) for(let c = 0; c < size; c++){
    if(!m[r][c]) continue;
    for(let y = 0; y < scale; y++){
      const rowBase = ((r + quiet) * scale + y) * dim + (c + quiet) * scale;
      px.fill(0, rowBase, rowBase + scale);
    }
  }
  return pngGrayscale(dim, dim, px);
}
function imageResponse(bytes, type, extra){
  return new Response(bytes, {
    status: 200,
    headers: Object.assign({
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    }, extra || {})
  });
}

/* ------------------------------------------------------------ r2 media ------ */
/* Object keys we accept on the public media route. Anything else is rejected,
   so the route can never be used to walk the bucket. */
const MEDIA_KEY_RE = /^(events\/[0-9]+\/[A-Za-z0-9_-]+\.(jpg|png|webp)|organizers\/[0-9]+\/[A-Za-z0-9_-]+\.(jpg|png|webp))$/;
function mediaUrlFor(request, key){
  if(!key) return null;
  const origin = new URL(request.url).origin;
  return origin + "/media/" + key;
}

/* ============================================================================
   ORDERS + INVENTORY + TICKETS
   ========================================================================== */
/* Stock is claimed with a guarded UPDATE: D1 serialises writers, so the
   "sold + qty <= quantity" test can never be won twice by two buyers. */
async function reserveStock(env, ticketTypeId, qty){
  const res = await dbRun(env,
    "UPDATE ticket_types SET sold = sold + ?, updated_at = ? WHERE id = ? AND status = 'active' AND sold + ? <= quantity",
    [qty, touch(), ticketTypeId, qty]);
  return !!(res && res.meta && res.meta.changes === 1);
}
async function releaseStock(env, ticketTypeId, qty){
  await dbRun(env, "UPDATE ticket_types SET sold = MAX(0, sold - ?), updated_at = ? WHERE id = ?", [qty, touch(), ticketTypeId]);
}
async function releaseOrderInventory(env, orderId){
  const res = await dbRun(env, "UPDATE orders SET inventory_held = 0, updated_at = ? WHERE id = ? AND inventory_held = 1", [touch(), orderId]);
  if(!(res && res.meta && res.meta.changes === 1)) return;      // already released
  const items = await dbAll(env, "SELECT ticket_type_id, quantity FROM order_items WHERE order_id = ?", [orderId]);
  for(const it of items) await releaseStock(env, it.ticket_type_id, Number(it.quantity));
}
async function uniqueTicketNumber(env){
  for(let attempt = 0; attempt < 6; attempt++){
    const candidate = ticketNumber();
    const clash = await dbGet(env, "SELECT id FROM tickets WHERE ticket_number = ?", [candidate]);
    if(!clash) return candidate;
  }
  return "PAT-" + randomToken(10).toUpperCase().replace(/[^A-Z0-9]/g, "X");
}
/* Ticket issuing is idempotent: it tops an order up to the quantity actually
   ordered, so a replayed webhook can never mint duplicate tickets. */
async function generateTickets(env, order){
  const items = await dbAll(env, "SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC", [order.id]);
  const expected = items.reduce((sum, it) => sum + Number(it.quantity), 0);
  if(!expected) return { created: 0, total: 0 };
  const grouped = await dbAll(env, "SELECT ticket_type_id, COUNT(*) AS n FROM tickets WHERE order_id = ? GROUP BY ticket_type_id", [order.id]);
  const have = {};
  for(const g of grouped) have[g.ticket_type_id] = Number(g.n);
  let created = 0;
  for(const it of items){
    const already = have[it.ticket_type_id] || 0;
    for(let i = already; i < Number(it.quantity); i++){
      let stored = false;
      for(let attempt = 0; attempt < 5 && !stored; attempt++){
        const number = await uniqueTicketNumber(env);
        const token = randomToken(24);
        try {
          await dbRun(env, "INSERT INTO tickets (order_id, event_id, ticket_type_id, attendee_name, attendee_email, attendee_phone, ticket_number, qr_token, status, checked_in) VALUES (?,?,?,?,?,?,?,?,'valid',0)",
            [order.id, order.event_id, it.ticket_type_id, order.customer_name, order.customer_email || null, order.customer_phone || null, number, token]);
          stored = true;
          created++;
        } catch(e){
          if(String((e && e.message) || "").indexOf("UNIQUE") < 0) throw e;
        }
      }
      if(!stored) throw err(500, "We could not issue all of your tickets. Please contact support.", "TICKET_ISSUE");
    }
  }
  return { created: created, total: expected };
}
/* Marks a paid order. Runs at most one state transition no matter how many
   times the provider notifies us. Reconcile may revive a 'failed' order: the
   provider is the authority, so failed->paid is allowed here (only here). */
async function markOrderPaid(env, order, payment, providerRef, snapshot, request, task){
  const res = await dbRun(env, "UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ? AND status != 'paid'",
    [touch(), touch(), order.id]);
  const firstTime = !!(res && res.meta && res.meta.changes === 1);
  if(payment){
    await dbRun(env, "UPDATE payments SET status = 'success', paid_at = COALESCE(paid_at, ?), provider_ref = COALESCE(?, provider_ref), provider_response = ?, provider_metadata = COALESCE(provider_metadata, ?), failure_reason = NULL, updated_at = ? WHERE id = ?",
      [touch(), providerRef || null, snapshot ? JSON.stringify(snapshot).slice(0, 4000) : null,
       metadataFor(payment.provider, snapshot), touch(), payment.id]);
  }
  const issued = await generateTickets(env, order);
  const fresh = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [order.id]);
  /* The ticket email and the organizer alert are queued only by the call that
     actually moved the order to 'paid', so a replayed webhook never re-sends. */
  if(firstTime) await sendOrderPaidEmails(env, fresh, request, task);
  return { first_time: firstTime, tickets: issued, order: fresh };
}
async function failOrder(env, order, payment, snapshot, request, task, reason){
  const res = await dbRun(env, "UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", [touch(), order.id]);
  const firstFailure = !!(res && res.meta && res.meta.changes === 1);
  if(payment){
    /* Never overwrite a success with a failure: a late "failed" notification for
       an order that already paid must not touch the transaction record. */
    await dbRun(env, "UPDATE payments SET status = 'failed', failure_reason = ?, failure_at = COALESCE(failure_at, ?), provider_response = ?, provider_metadata = COALESCE(provider_metadata, ?), updated_at = ? WHERE id = ? AND status = 'pending'",
      [String(reason || "failed").slice(0, 120), touch(), snapshot ? JSON.stringify(snapshot).slice(0, 4000) : null,
       metadataFor(payment.provider, snapshot), touch(), payment.id]);
  }
  if(firstFailure) await sendPaymentFailedEmail(env, order, request, task, reason);
}
/* Provider-specific metadata, kept in the one common transaction table so a
   report or a support agent sees the same columns for every gateway. */
function metadataFor(providerKey, snapshot){
  if(!snapshot || typeof snapshot !== "object") return null;
  const pick = providerKey === "payhero"
    ? ["reference", "checkout_request_id", "mpesa_receipt", "provider_reference", "status", "channel_id", "phone_last4"]
    : (providerKey === "pesapal"
      ? ["order_tracking_id", "merchant_reference", "status_code", "payment_method", "confirmation_code"]
      : ["reference", "access_code", "channel", "id", "gateway_response"]);
  const out = {};
  for(const key of pick) if(snapshot[key] !== undefined && snapshot[key] !== null) out[key] = snapshot[key];
  return Object.keys(out).length ? JSON.stringify(out).slice(0, 2000) : null;
}
/* Whitelisted provider metadata as a plain object. The public status route only
   ever returns fields a customer already has on their own receipt or SMS: no
   organizer channel id, no phone digits, no credential material, ever. */
const PUBLIC_METADATA_FIELDS = ["reference", "status", "mpesa_receipt", "provider_reference", "channel",
  "payment_method", "confirmation_code", "merchant_reference", "order_tracking_id", "id", "access_code"];
function safeProviderMetadata(providerKey, raw){
  let parsed = null;
  if(typeof raw === "string" && raw){ try { parsed = JSON.parse(raw); } catch(e){ parsed = null; } }
  else if(raw && typeof raw === "object") parsed = raw;
  if(!parsed) return null;
  const out = {};
  for(const key of PUBLIC_METADATA_FIELDS){
    const value = parsed[key];
    if(value !== undefined && value !== null && typeof value !== "object") out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}
async function orderItemsFor(env, orderId){
  return dbAll(env, "SELECT oi.*, tt.name AS ticket_type_name FROM order_items oi LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ? ORDER BY oi.id ASC", [orderId]);
}
/* The money trail: WHO collected this order's money, frozen at checkout time so
   flipping an event's payment_mode mid-sale never rewrites history.
   - owner_mode true  -> collected_via "owner" (platform owner's account)
   - otherwise        -> collected_via "organizer" (organizer's own account) */
function collectedViaOf(resolved){
  return (resolved && resolved.owner_mode === true) ? "owner" : "organizer";
}
/* Best-effort probe for the money-trail columns (migration 0007): cached,
   never throws, so code runs fine before the migration is applied. */
let MONEY_TRAIL_COLS = null;
async function moneyTrailCols(env){
  if(MONEY_TRAIL_COLS) return MONEY_TRAIL_COLS;
  try {
    const rows = await dbAll(env, "PRAGMA table_info(orders)", []);
    const names = {};
    (rows || []).forEach(r => { names[String(r.name || "")] = true; });
    MONEY_TRAIL_COLS = { collected_via: !!names.collected_via,
      payment_provider: !!names.payment_provider, provider_label: !!names.provider_label };
  } catch(e){ MONEY_TRAIL_COLS = { collected_via: false, payment_provider: false, provider_label: false }; }
  return MONEY_TRAIL_COLS;
}
/* Stamp one order row with its money trail. Safe on every checkout: no-op
   when the columns do not exist yet, never throws. */
async function stampOrderMoneyTrail(env, orderId, resolved, providerKey){
  try {
    const cols = await moneyTrailCols(env);
    if(!cols.collected_via && !cols.payment_provider && !cols.provider_label) return;
    const sets = [], params = [];
    if(cols.collected_via){ sets.push("collected_via = ?"); params.push(collectedViaOf(resolved)); }
    if(cols.payment_provider){ sets.push("payment_provider = ?"); params.push(providerKey || (resolved && resolved.provider_key) || null); }
    if(cols.provider_label){ sets.push("provider_label = ?"); params.push(providerLabel(providerKey || (resolved && resolved.provider_key) || "")); }
    if(!sets.length) return;
    sets.push("updated_at = ?"); params.push(touch()); params.push(orderId);
    await dbRun(env, "UPDATE orders SET " + sets.join(", ") + " WHERE id = ?", params);
  } catch(e){ /* informational only: checkout must never fail on it */ }
}
async function providersForOrders(env, rows){
  const byOrder = {};
  const ids = (rows || []).map(o => o.id).filter(id => id !== undefined && id !== null);
  if(!ids.length) return byOrder;
  const marks = ids.map(() => "?").join(",");
  const found = await dbAll(env, "SELECT order_id, provider, reference, provider_ref, amount, currency, status, failure_reason, failure_at, provider_metadata, paid_at, created_at, updated_at FROM payments WHERE order_id IN (" + marks + ") ORDER BY id ASC", ids);
  (found || []).forEach(p => {
    const current = byOrder[p.order_id];
    /* A successful transaction wins over a later retry, and the first one
       otherwise, so a retried payment still shows the gateway that settled. */
    if(!current || (current.status !== "success" && p.status === "success")) byOrder[p.order_id] = p;
  });
  return byOrder;
}
/* Owner-visible payment detail. The owner sees every gateway field EXCEPT raw
   provider_response (full provider payload) and secrets: only the whitelisted
   metadata object is exposed. Safe for the platform owner support view. */
function ownerPaymentDetail(p){
  if(!p) return null;
  return {
    provider: p.provider || null,
    provider_label: p.provider ? providerLabel(p.provider) : null,
    reference: p.reference || null,
    provider_ref: p.provider_ref || null,
    amount: p.amount != null ? Number(p.amount) : null,
    currency: p.currency || null,
    status: p.status || null,
    failure_reason: p.failure_reason || null,
    failure_at: p.failure_at || null,
    paid_at: p.paid_at || null,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    metadata: safeProviderMetadata(p.provider, p.provider_metadata)
  };
}
function orderPaymentFields(byOrder, orderId){
  const p = byOrder[orderId] || null;
  return {
    provider: p ? p.provider : null,
    provider_label: p ? providerLabel(p.provider) : null,
    transaction_status: p ? p.status : null,
    /* Full gateway trail for the owner orders table (reference, provider ref,
       failure reason, timestamps, whitelisted metadata). */
    paystack_reference: p ? (p.reference || null) : null,
    provider_reference: p ? (p.provider_ref || null) : null,
    payment_reference: p ? (p.reference || null) : null,
    transaction_reference: p ? (p.provider_ref || null) : null,
    failure_reason: p ? (p.failure_reason || null) : null,
    failure_at: p ? (p.failure_at || null) : null,
    payment_paid_at: p ? (p.paid_at || null) : null,
    payment_detail: ownerPaymentDetail(p)
  };
}
/* Retry visibility for one owner order row: a failed/pending order with a
   gateway transaction can be reconciled (server re-verifies with the
   provider). Paid orders never show retry; cancelled/refunded are terminal. */
function ownerReconcileFlag(orderStatus, payment){
  return (orderStatus === "failed" || orderStatus === "pending") && !!payment;
}
/* Money-trail enrichment for already-fetched order rows (frozen snapshot when
   present, else the live payments row for pre-0007 legacy orders). */
async function moneyTrailForOrders(env, rows){
  const byId = {};
  const needPayment = [];
  (rows || []).forEach(o => {
    const snapVia = o.collected_via ? String(o.collected_via) : null;
    const snapProv = o.payment_provider || null;
    if(snapVia && snapProv){
      byId[o.id] = { collected_via: snapVia, payment_provider: snapProv,
        provider_label: o.provider_label || providerLabel(snapProv),
        collected_via_label: snapVia === "owner" ? "Owner account" : "Organizer account", frozen: true };
    } else needPayment.push(o.id);
  });
  if(needPayment.length){
    try {
      const marks = needPayment.map(() => "?").join(",");
      const found = await dbAll(env, "SELECT order_id, provider, status FROM payments WHERE order_id IN (" + marks + ") ORDER BY id ASC", needPayment);
      const first = {};
      (found || []).forEach(p => { if(!first[p.order_id]) first[p.order_id] = p; });
      (rows || []).forEach(o => {
        if(byId[o.id]) return;
        const p = first[o.id] || null;
        const prov = o.payment_provider || (p && p.provider) || null;
        const via = o.collected_via ? String(o.collected_via) : "unknown";
        byId[o.id] = { collected_via: via, payment_provider: prov,
          provider_label: prov ? (o.provider_label || providerLabel(prov)) : null,
          collected_via_label: via === "owner" ? "Owner account" : (via === "organizer" ? "Organizer account" : "Unknown (before tracking)"),
          frozen: !!(o.collected_via && prov) };
      });
    } catch(e){
      (rows || []).forEach(o => { if(!byId[o.id]) byId[o.id] = { collected_via: o.collected_via ? String(o.collected_via) : "unknown",
        payment_provider: o.payment_provider || null, provider_label: o.payment_provider ? (o.provider_label || providerLabel(o.payment_provider)) : null,
        collected_via_label: "Unknown (before tracking)", frozen: false }; });
    }
  }
  return byId;
}
function orderMoneyFields(trail, orderId){
  const t = (trail && trail[orderId]) || null;
  return { collected_via: t ? t.collected_via : "unknown",
    collected_via_label: t ? t.collected_via_label : "Unknown (before tracking)",
    payment_provider_name: t ? t.payment_provider : null,
    provider_name: t ? t.provider_label : null };
}
function orderPayload(order, items, payment, tickets){
  return {
    id: order.id,
    order_number: order.order_number,
    reference: order.order_number,
    event_id: order.event_id,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    customer_phone: order.customer_phone,
    amount: Number(order.total_amount),
    total_amount: Number(order.total_amount),
    currency: order.currency,
    status: order.status,
    paid_at: order.paid_at,
    created_at: order.created_at,
    items: (items || []).map(it => ({
      ticket_type_id: it.ticket_type_id,
      ticket_type_name: it.ticket_type_name || null,
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
      subtotal: Number(it.subtotal)
    })),
    ticket_count: (tickets || []).length,
    tickets: tickets || [],
    provider: payment ? payment.provider : null,
    payment_status: payment ? payment.status : null
  };
}
function ticketPayload(t, extra){
  return Object.assign({
    ticket_number: t.ticket_number,
    status: t.status,
    checked_in: !!t.checked_in,
    checked_in_at: t.checked_in_at,
    attendee_name: t.attendee_name,
    ticket_type_id: t.ticket_type_id,
    ticket_type_name: t.ticket_type_name || null,
    event_id: t.event_id,
    event_title: t.event_title || null,
    event_date: t.event_date || null,
    start_time: t.start_time || null,
    venue: t.venue || null,
    location: t.location || null,
    poster_url: t.poster_url || null,
    order_number: t.order_number || null,
    created_at: t.created_at
  }, extra || {});
}
const TICKET_SELECT = "SELECT t.*, tt.name AS ticket_type_name, e.title AS event_title, e.event_date, e.start_time, e.venue, e.location, e.poster_url, o.order_number, o.status AS order_status FROM tickets t LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id LEFT JOIN events e ON e.id = t.event_id LEFT JOIN orders o ON o.id = t.order_id";

/* ============================================================================
   PAYMENT PROVIDER ABSTRACTION
   ----------------------------------------------------------------------------
   The order system never talks to Paystack, Pesapal or PayHero directly: it
   calls PaymentService, which resolves the provider for the event (see
   resolveEffectiveProvider) and dispatches to the provider adapter. Adding a
   provider means adding ONE object to PROVIDERS and one entry to
   PAYMENT_PROVIDER_KEYS - no order, ticket, email or reporting code changes.

       TicketHub
         -> PaymentService            (createPayment / validatePayment /
                                       getPaymentStatus / handleCallback /
                                       processWebhook / refundPayment)
           -> provider adapter        (pesapal | paystack | payhero)
             -> provider API          (verification is always provider specific)

   Credentials live per organizer AND per provider in
   organizer_payment_providers; AES-GCM ciphertext never leaves the server.
   ========================================================================== */
const PROVIDER_LABELS = { pesapal: "Pesapal", paystack: "Paystack", payhero: "PayHero" };
/* One sentence for the one situation that must never silently fall back to a
   different provider. Organizers see the actionable version, customers a safe
   version without any infrastructure detail. */
const PROVIDER_NOT_CONFIGURED_MESSAGE = "Your selected payment provider is not currently configured. Please update your Payment Settings.";
const PROVIDER_UNAVAILABLE_MESSAGE = "Payments are temporarily unavailable for this event. Please try again later or contact the organizer.";
function providerLabel(key){ return PROVIDER_LABELS[String(key || "").toLowerCase()] || String(key || ""); }
function isProviderKey(key){ return PAYMENT_PROVIDER_KEYS.indexOf(String(key || "").toLowerCase()) > -1; }
const CONNECTION_LABELS = {
  not_connected: "Not Connected", connected: "Connected",
  configuration_required: "Configuration Required", error: "Error"
};

async function hmacSha512Hex(secret, message){
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, utf8(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* Constant-time-ish string compare for signatures/tokens. */
function safeEqual(a, b){
  const x = String(a || ""), y = String(b || "");
  if(x.length !== y.length) return false;
  let diff = 0;
  for(let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
async function providerFetch(url, opts, timeoutMs){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal }));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e){ data = null; }
    /* A gateway rejection is the only clue an operator ever gets when checkout
       fails: the thrown error carries a buyer-safe sentence and the raw body
       would otherwise be discarded, so the reason is preserved in the Worker's
       own logs (query strings stripped, no request credentials logged). */
    if(!res.ok){
      console.error("provider_fetch_failed " + res.status + " " + String(url).split("?")[0] + " :: " + String(text || "").slice(0, 300));
    }
    return { ok: res.ok, status: res.status, data: data, text: text };
  } catch(e){
    console.error("provider_fetch_error " + String(url).split("?")[0] + " :: " + ((e && e.message) || e));
    return { ok: false, status: 0, data: null, text: "network" };
  } finally {
    clearTimeout(timer);
  }
}
async function loadPaymentSettings(env, organizerId){
  return dbGet(env, "SELECT * FROM payment_settings WHERE organizer_id = ?", [organizerId]);
}
/* ------------------------------------------------ provider config store -----
   organizer_payment_providers holds one row per organizer+provider. The legacy
   payment_settings columns are still read as a fallback, so an organizer who
   connected Pesapal or Paystack before PayHero existed keeps selling without
   changing anything. */
async function loadProviderRows(env, organizerId){
  const rows = await dbAll(env, "SELECT * FROM organizer_payment_providers WHERE organizer_id = ?", [organizerId]);
  const map = {};
  for(const row of rows) map[String(row.provider)] = row;
  return map;
}
async function loadProviderRow(env, organizerId, providerKey){
  if(!organizerId) return null;
  return dbGet(env, "SELECT * FROM organizer_payment_providers WHERE organizer_id = ? AND provider = ?", [organizerId, providerKey]);
}
/* The platform OWNER's own merchant accounts (owner payment mode). Same shape as
   an organizer's provider rows, one row per provider, no organizer_id. A database
   that has not run migration 0005 yet simply reports "no owner account" instead
   of failing the request. */
async function loadPlatformProviderRows(env){
  const map = {};
  let rows = [];
  try { rows = await dbAll(env, "SELECT * FROM platform_payment_providers", []); }
  catch(e){ rows = []; }
  for(const row of rows) map[String(row.provider)] = row;
  return map;
}
async function loadPlatformProviderRow(env, providerKey){
  try { return await dbGet(env, "SELECT * FROM platform_payment_providers WHERE provider = ?", [providerKey]); }
  catch(e){ return null; }
}
/* Writes/updates one platform setting. Small helper so the owner payment routes
   and the owner settings route share one upsert. */
async function setAppSetting(env, key, value){
  const existing = await dbGet(env, "SELECT key FROM app_settings WHERE key = ?", [key]);
  if(existing) await dbRun(env, "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?", [value, touch(), key]);
  else await dbRun(env, "INSERT INTO app_settings (key, value) VALUES (?,?)", [key, value]);
}
/* Normalises a provider row into the non-secret fields the UI may see. Secret
   columns are replaced by boolean "has_..." indicators - never echoed back. */
function providerFields(row){
  const r = row || {};
  return {
    public_key: r.public_key || null,
    consumer_key: r.consumer_key || null,
    ipn_id: r.ipn_id || null,
    api_username: r.api_username || null,
    channel_id: (r.channel_id === undefined || r.channel_id === null) ? null : String(r.channel_id),
    has_secret_key: !!r.secret_key_encrypted,
    has_consumer_secret: !!r.consumer_secret_encrypted,
    has_password: !!r.password_encrypted
  };
}
/* Every field a provider needs before it can take money. */
const PROVIDER_FIELDS = {
  pesapal:  ["consumer_key", "consumer_secret"],
  paystack: ["secret_key"],
  payhero:  ["api_username", "password", "channel_id"]
};
function hasChannel(r){ return !!(r && r.channel_id !== undefined && r.channel_id !== null && String(r.channel_id).trim() !== ""); }
function fieldPresent(providerKey, row, field){
  if(!row) return false;
  if(field === "consumer_secret") return !!row.consumer_secret_encrypted;
  if(field === "secret_key") return !!row.secret_key_encrypted;
  if(field === "password") return !!row.password_encrypted;
  if(field === "channel_id") return hasChannel(row);
  return !!row[field];
}
function rowConfigured(providerKey, row){
  const fields = PROVIDER_FIELDS[String(providerKey)];
  return fields ? fields.every(f => fieldPresent(providerKey, row, f)) : false;
}
function rowPartial(providerKey, row){
  const fields = PROVIDER_FIELDS[String(providerKey)];
  return fields ? fields.some(f => fieldPresent(providerKey, row, f)) : false;
}
/* The legacy payment_settings row, seen as a provider-shaped config row. */
function legacyRowFor(settings, providerKey){
  if(!settings) return null;
  if(providerKey === "paystack"){
    if(!settings.secret_key_encrypted && !settings.public_key) return null;
    return { provider: "paystack", public_key: settings.public_key || null,
      secret_key_encrypted: settings.secret_key_encrypted || null,
      status: settings.status, last_tested_at: settings.last_tested_at, last_error: settings.last_error, legacy: true };
  }
  if(providerKey === "pesapal"){
    if(!settings.consumer_key && !settings.consumer_secret_encrypted) return null;
    return { provider: "pesapal", consumer_key: settings.consumer_key || null, ipn_id: settings.ipn_id || null,
      consumer_secret_encrypted: settings.consumer_secret_encrypted || null,
      status: settings.status, last_tested_at: settings.last_tested_at, last_error: settings.last_error, legacy: true };
  }
  return null;
}
/* Platform-level credentials for one provider. The platform OWNER's own account
   (set from the owner area, stored encrypted in platform_payment_providers) is
   preferred; the Worker-secret values remain a fallback for deployments that
   configure them in the dashboard. These are only ever used for the SAME
   provider - never to move an organizer onto a different gateway. */
async function platformCredentials(env, providerKey){
  const ownerRow = await loadPlatformProviderRow(env, providerKey);
  if(ownerRow && Number(ownerRow.enabled) !== 0){
    const own = await credentialsFromRow(env, providerKey, ownerRow);
    if(own) return Object.assign({}, own, { source: "platform", owner: true });
  }
  if(providerKey === "paystack" && env.PAYSTACK_SECRET_KEY)
    return { source: "platform", owner: false, secret: env.PAYSTACK_SECRET_KEY, public_key: null };
  if(providerKey === "pesapal" && env.PESAPAL_CONSUMER_KEY && env.PESAPAL_CONSUMER_SECRET)
    return { source: "platform", owner: false, consumer_key: env.PESAPAL_CONSUMER_KEY, consumer_secret: env.PESAPAL_CONSUMER_SECRET, ipn_id: null };
  if(providerKey === "payhero" && env.PAYHERO_API_USERNAME && env.PAYHERO_API_PASSWORD && env.PAYHERO_CHANNEL_ID)
    return { source: "platform", owner: false, username: env.PAYHERO_API_USERNAME, password: env.PAYHERO_API_PASSWORD, channel_id: String(env.PAYHERO_CHANNEL_ID) };
  return null;
}
async function platformConfigured(env, providerKey){ return !!(await platformCredentials(env, providerKey)); }
/* ------------------------------------------------------ owner payment mode ---
   The platform owner can collect on behalf of an organizer. An event is in owner
   mode when it says so itself, otherwise when the organizer's account default is
   on. Which provider and which credentials then come from the owner store, never
   from the organizer's own account. */
async function organizerUsesOwnerPayments(env, organizerId){
  if(!organizerId) return false;
  /* A database that has not run migration 0005 has no use_owner_payments column.
     Owner mode is simply unavailable there, never an error. */
  try {
    const row = await dbGet(env, "SELECT use_owner_payments FROM organizers WHERE id = ?", [organizerId]);
    return !!(row && Number(row.use_owner_payments) === 1);
  } catch(e){ return false; }
}
async function ownerActiveProviderKey(env){
  try {
    const row = await dbGet(env, "SELECT value FROM app_settings WHERE key = ?", ["owner_payment_active_provider"]);
    const key = row ? String(row.value || "").toLowerCase() : "";
    return isProviderKey(key) ? key : "paystack";
  } catch(e){ return "paystack"; }
}
async function ownerPaymentsEnabled(env){
  try {
    const row = await dbGet(env, "SELECT value FROM app_settings WHERE key = ?", ["owner_payment_enabled"]);
    return !row || String(row.value) !== "false";
  } catch(e){ return true; }
}
async function ownerModeForEvent(env, event){
  if(!event) return false;
  const mode = String(event.payment_mode || "").toLowerCase();
  if(mode === "owner") return true;
  if(mode === "own") return false;
  return organizerUsesOwnerPayments(env, event.organizer_id);
}
/* The row that actually holds this provider's configuration, plus whether it
   came from the legacy columns (so a save knows which store to write). */
function configSourceFor(settings, row, providerKey){
  if(rowConfigured(providerKey, row)) return { row: row, legacy: false };
  const legacy = legacyRowFor(settings, providerKey);
  if(legacy && rowConfigured(providerKey, legacy)) return { row: legacy, legacy: true };
  return { row: row || legacy || null, legacy: !row && !!legacy };
}
/* Decrypts one configuration row into usable credentials. The ONLY place a
   secret is turned back into plaintext, and it is never returned or logged. */
async function credentialsFromRow(env, providerKey, row){
  if(!row) return null;
  if(providerKey === "paystack" && row.secret_key_encrypted){
    const secret = await decryptSecret(env, row.secret_key_encrypted);
    if(secret) return { source: "organizer", secret: secret, public_key: row.public_key || null };
  }
  if(providerKey === "pesapal" && row.consumer_key && row.consumer_secret_encrypted){
    const secret = await decryptSecret(env, row.consumer_secret_encrypted);
    if(secret) return { source: "organizer", consumer_key: row.consumer_key, consumer_secret: secret, ipn_id: row.ipn_id || null };
  }
  if(providerKey === "payhero" && row.api_username && row.password_encrypted && hasChannel(row)){
    const secret = await decryptSecret(env, row.password_encrypted);
    if(secret) return { source: "organizer", username: row.api_username, password: secret, channel_id: String(row.channel_id) };
  }
  return null;
}
/* Which provider does this organizer sell through? Defaults to paystack, which
   is the value every pre-PayHero row already carries. */
function providerKeyOf(settings){
  const key = settings ? String(settings.provider || "").toLowerCase() : "";
  return isProviderKey(key) ? key : "paystack";
}
/* Organizer-owned credentials only: the row in organizer_payment_providers (or the
   legacy payment_settings columns). NEVER the platform/shared account. This is
   what "Connected" means in Payment Settings and what normal checkout uses, so a
   brand-new organizer with no keys of their own is "Not Connected" even when the
   platform owner has connected the same provider. */
async function organizerCredentialsForRow(env, providerKey, row, settings){
  if(row){
    const own = await credentialsFromRow(env, providerKey, row);
    if(own) return own;
  }
  const legacy = legacyRowFor(settings, providerKey);
  if(legacy){
    const own = await credentialsFromRow(env, providerKey, legacy);
    if(own) return own;
  }
  return null;
}
/* Credentials: the organizer's own connected merchant account always wins.
   The platform-level Worker secrets are only a fallback for organizers who have
   not connected an account, and only for the SAME provider - a missing provider
   configuration never silently falls through to a different gateway.
   NOTE (strict mode): the fallback below is LEGACY ONLY - it exists so orders
   created before strict mode (billed to the platform account) can still be
   verified / settled via webhooks. New checkout and Payment Settings MUST use
   organizerCredentialsForRow / resolveCredentials with { allowPlatform: false }
   so money never silently routes to the platform account. */
/* Credentials for one provider, in the documented order: the organizer's own row
   (whichever store holds it), then the platform fallback for that same provider.
   `row` may be passed in by callers that already loaded it - loading it again
   would miss it whenever there is no payment_settings row yet. */
async function credentialsForRow(env, providerKey, row, settings){
  if(row){
    const own = await credentialsFromRow(env, providerKey, row);
    if(own) return own;
  }
  const legacy = legacyRowFor(settings, providerKey);
  if(legacy){
    const own = await credentialsFromRow(env, providerKey, legacy);
    if(own) return own;
  }
  return platformCredentials(env, providerKey);
}
/* Credentials for one provider. `preset` may carry `row` - the organizer's own
   configuration row, when the caller already loaded it (the resolver loads every
   provider row once, for all of its candidates) - and `organizer_id`, so a
   caller that knows the organizer does not have to leave it to be re-derived
   from the payment_settings row. Strict mode: pass { allowPlatform: false }
   (the default) to use ONLY the organizer's own keys. Pass
   { allowPlatform: true } ONLY for legacy settlement/webhook verification of
   orders created before strict mode, which may have been billed to the
   platform/shared account. */
async function resolveCredentials(env, settings, providerKey, preset){
  const orgId = (preset && preset.organizer_id) || (settings ? settings.organizer_id : null);
  const row = (preset && preset.row !== undefined) ? preset.row : (orgId ? await loadProviderRow(env, orgId, providerKey) : null);
  /* Strict mode: the organizer's own keys only. The platform/shared account is
     used ONLY for explicit owner payment mode (handled in
     resolveEffectiveProvider) and for legacy settlement (allowPlatform: true). */
  const own = await organizerCredentialsForRow(env, providerKey, row, settings);
  if(own) return own;
  if(preset && preset.allowPlatform === true) return credentialsForRow(env, providerKey, row, settings);
  return null;
}
/* -------------------------------------------------------- provider state ----
   The four states the Payment Settings page shows, derived from what is stored
   (never from anything the browser claims). */
function credsAddress(creds, providerKey){
  if(!creds) return null;
  if(providerKey === "pesapal") return creds.consumer_key || null;
  if(providerKey === "paystack") return creds.public_key || null;
  if(providerKey === "payhero") return creds.channel_id ? ("channel " + creds.channel_id) : null;
  return null;
}
async function providerState(env, settings, providerKey, row){
  /* The row the caller already loaded is used as-is: re-loading it here would
     lose a provider whose organizer has no payment_settings row yet. When the
     credentials live in the legacy columns, that row is the one the organizer
     must see - otherwise a pre-PayHero account would look unconfigured.
     STRICT: only the organizer's OWN keys count as connected. The platform's
     shared account is reported separately as platform_available so the UI can
     offer owner payment mode, but it never flips status to connected. */
  const source = configSourceFor(settings, row, providerKey);
  const storedRow = source.row || null;
  const creds = await organizerCredentialsForRow(env, providerKey, storedRow, settings);
  const platformCreds = creds ? null : await platformCredentials(env, providerKey);
  const ownKeys = !!(storedRow && rowConfigured(providerKey, storedRow));
  const legacyKeys = !!legacyRowFor(settings, providerKey);
  const partial = rowPartial(providerKey, storedRow);
  let status = "not_connected";
  if(creds && creds.source === "organizer"){
    const failed = String((storedRow && storedRow.status) || "") === "error"
      || (!row && settings && String(settings.status || "") === "error");
    status = failed ? "error" : "connected";
  } else if(partial || (legacyKeys && !ownKeys)) {
    status = "configuration_required";
  }
  return {
    status: status,
    label: CONNECTION_LABELS[status],
    configured: status === "connected",
    credentials_source: creds ? creds.source : null,
    /* The platform/shared account exists for this provider and could serve
       explicit owner payment mode events - informational only, never connected. */
    platform_available: !!platformCreds,
    platform_credentials: !!platformCreds,
    /* `enabled` only applies to a row the organizer owns in the new store. */
    enabled: row ? Number(row.enabled) !== 0 : true,
    last_tested_at: storedRow ? storedRow.last_tested_at : null,
    last_error: storedRow ? storedRow.last_error : null,
    fields: providerFields(storedRow),
    has_own_credentials: !!(ownKeys || legacyKeys),
    legacy_configured: legacyKeys,
    credentials_hint: credsAddress(creds, providerKey)
  };
}
function callbackUrlFor(env, request, reference){
  const configured = String(env.FRONTEND_URL || "").replace(/\/+$/, "");
  const origin = configured || PRODUCTION_FRONTEND_URL;
  return origin + "/payment-success/?reference=" + encodeURIComponent(reference);
}
function providerKeyFromRequest(env, url){
  const q = url.searchParams.get("provider");
  return q && isProviderKey(q) ? q.toLowerCase() : null;
}
/* ============================================================================
   PAYMENT PROVIDER RESOLVER
   ----------------------------------------------------------------------------
   Exactly one priority order, defined once:

       1. OWNER MODE ONLY: when the event (or the organizer's account default)
          explicitly asks for the platform owner's account, ONLY the owner
          store is consulted.
       2. otherwise the event's own provider, when an organizer explicitly set
          one AND it is connected with the organizer's OWN keys
       3. otherwise the organizer's Active Payment Provider (own keys only)
       4. otherwise "payment provider not configured" - never a different
          gateway, and never a silent fallback to the platform/shared account.

   STRICT: "Configured" means the ORGANIZER's own merchant account only. The
   platform account is usable ONLY inside explicit owner payment mode.
   ========================================================================== */
async function resolveEffectiveProvider(env, ctx){
  const event = ctx.event || null;
  const organizerId = ctx.organizer_id || (event ? event.organizer_id : null);
  const settings = (ctx.settings !== undefined) ? ctx.settings : await loadPaymentSettings(env, organizerId);
  const rows = ctx.rows || (organizerId ? await loadProviderRows(env, organizerId) : {});
  const activeKey = providerKeyOf(settings);
  const info = { organizer_id: organizerId, settings: settings, rows: rows, active_key: activeKey,
    event_key: null, provider_key: null, creds: null, configured: false, source: null, disabled: false,
    owner_mode: false, owner_key: null };
  const eventKey = event ? String(event.payment_provider || "").toLowerCase() : "";

  /* OWNER PAYMENT MODE. When the event (or the organizer's account default) is
     set to collect through the platform owner's account, ONLY the owner store is
     consulted. The organizer's own connected account is deliberately ignored, so
     choosing owner mode can never silently fall back to a different account than
     the one the organizer asked for. */
  const ownerMode = (ctx.owner_mode !== undefined)
    ? !!ctx.owner_mode
    : (event ? await ownerModeForEvent(env, event) : false);
  if(ownerMode && await ownerPaymentsEnabled(env)){
    info.owner_mode = true;
    const candidates = [];
    if(isProviderKey(eventKey)) candidates.push(eventKey);
    const ownerActive = await ownerActiveProviderKey(env);
    candidates.push(ownerActive);
    for(const key of candidates){
      const creds = await platformCredentials(env, key);
      if(creds){
        info.provider_key = key;
        info.owner_key = key;
        info.source = "owner";
        info.creds = creds;
        info.configured = true;
        return info;
      }
    }
    info.provider_key = ownerActive;
    info.owner_key = ownerActive;
    return info;
  }

  const candidates = [];
  if(isProviderKey(eventKey)){
    info.event_key = eventKey;
    candidates.push({ key: eventKey, from: "event" });
  }
  candidates.push({ key: activeKey, from: "organizer" });
  for(const candidate of candidates){
    const row = rows[candidate.key] || null;
    const disabled = !!(row && Number(row.enabled) === 0);
    /* The row and the organizer id resolved above are handed to the credentials
       lookup: it must not re-read the organizer from payment_settings, or a
       provider whose organizer has no payment_settings row yet would look
       unconfigured here while Payment Settings shows it as connected. */
    const creds = disabled ? null : await resolveCredentials(env, settings, candidate.key,
      { row: row, organizer_id: organizerId });
    if(creds){
      info.provider_key = candidate.key;
      info.source = candidate.from;
      info.creds = creds;
      info.configured = true;
      return info;
    }
    if(candidate.from === "event"){
      /* An event override that is no longer configured is reported, not obeyed:
         the organizer's active provider is tried next. */
      info.event_unavailable = candidate.key;
      info.event_disabled = disabled;
    }
  }
  info.provider_key = info.event_key || activeKey;
  const row = rows[info.provider_key];
  info.disabled = !!(row && Number(row.enabled) === 0);
  return info;
}
/* One sentence for the organizer/admin surfaces when nothing is usable. */
function providerProblemMessage(info){
  if(!info) return PROVIDER_NOT_CONFIGURED_MESSAGE;
  if(info.owner_mode){
    return "This event is set to collect through the platform owner's account, but the owner has not connected a usable payment provider yet. Ask the platform owner to connect one, or switch this event back to your own account.";
  }
  if(info.disabled && info.provider_key){
    return providerLabel(info.provider_key) + " is disabled in your Payment Settings, so checkout is closed. Enable it or set another provider as active.";
  }
  if(info.event_unavailable){
    return "This event is set to use " + providerLabel(info.event_unavailable)
      + ", which is not configured on your account. Update the event or your Payment Settings.";
  }
  return PROVIDER_NOT_CONFIGURED_MESSAGE;
}
/* The single entry point every order, payment, webhook and refund route uses. */
const PaymentService = {
  keys(){ return PAYMENT_PROVIDER_KEYS.slice(); },
  provider(key){ return providerFor(key); },
  label(key){ return providerLabel(key); },
  /* Which provider serves this event, and with which credentials. */
  resolve(ctx){ return resolveEffectiveProvider(ctx.env, ctx); },
  async credentialsFor(env, organizerId, providerKey){
    const settings = await loadPaymentSettings(env, organizerId);
    const key = providerKey || providerKeyOf(settings);
    /* The organizer is named explicitly: it is known here, and re-deriving it
       from a payment_settings row that may not exist yet would hide an organizer's
       own provider row from refunds and webhook verification. */
    return { settings: settings, provider_key: key,
      creds: await resolveCredentials(env, settings, key, { organizer_id: organizerId }) };
  },
  /* POST /api/orders + POST /api/payments/create */
  async createPayment(ctx){
    const provider = providerFor(ctx.provider_key);
    return provider.initiate(ctx);
  },
  /* GET /api/payments/:reference - ask the provider, server to server. */
  async getPaymentStatus(ctx){
    const provider = providerFor(ctx.provider_key);
    return provider.verify(ctx);
  },
  /* Amount/currency/reference checks every provider result must pass before a
     single ticket is issued. Shared, so no provider can forget one. */
  validatePayment(order, verification){
    if(!verification) return { ok: false, mismatch: "no_verification" };
    const expected = Number(order.total_amount);
    if(verification.amount != null && Math.round(Number(verification.amount)) !== expected){
      return { ok: false, mismatch: "amount", expected: expected, reported: verification.amount };
    }
    if(verification.currency && String(verification.currency).toUpperCase() !== String(order.currency || "KES").toUpperCase()){
      return { ok: false, mismatch: "currency", expected: order.currency, reported: verification.currency };
    }
    return { ok: true };
  },
  /* Provider-specific authenticity check for an inbound callback. */
  verifyWebhook(ctx){
    const provider = providerFor(ctx.provider_key);
    if(typeof provider.verifyWebhook !== "function") return { verified: false, reason: "unsupported" };
    return provider.verifyWebhook(ctx);
  },
  /* The one path that can mark an order paid. */
  settle(ctx){
    return settlePayment(ctx.env, ctx.order, ctx.payment, providerFor(ctx.provider_key), ctx.creds,
      ctx.provider_ref, ctx.request, ctx.task, ctx.hints || null);
  },
  /* Refunds differ per gateway. The method exists on all of them and refuses
     clearly instead of pretending an automation exists. */
  async refundPayment(ctx){
    const provider = providerFor(ctx.provider_key);
    if(typeof provider.refund !== "function"){
      throw err(501, "Refunds are not automated for " + providerLabel(ctx.provider_key) + ". Record the refund from your " + providerLabel(ctx.provider_key) + " dashboard.", "REFUND_UNSUPPORTED");
    }
    return provider.refund(ctx);
  }
};
/* --------------------------------------------------------------- pesapal ----
   Pesapal v3. An IPN notification is NEVER treated as final: every notification
   is followed by a GetTransactionStatus call whose amount, currency and
   merchant reference must match our order before tickets are issued. */
const PesapalProvider = {
  key: "pesapal",
  label: "Pesapal",
  currency: "KES",
  /* Which Pesapal account this deployment dials. Sandbox and live are two
     separate accounts, and the choice is a deployment variable, so every verdict
     this adapter gives has to name it: otherwise a live key pair answered by the
     sandbox reads to the organizer as "wrong consumer key". */
  environment(env){
    return String((env && env.PESAPAL_ENV) || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
  },
  base(env){
    return this.environment(env) === "live"
      ? "https://pay.pesapal.com/v3/api"
      : "https://cybqa.pesapal.com/pesapalv3/api";
  },
  async token(env, creds){
    const res = await providerFetch(this.base(env) + "/Auth/RequestToken", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ consumer_key: creds.consumer_key, consumer_secret: creds.consumer_secret })
    });
    const d = res.data || {};
    if(!res.ok || !d.token){
      /* The buyer only ever sees the safe sentence below. The environment is the
         operator's diagnostic: it is the one fact a log needs to tell a genuinely
         wrong key apart from live keys dialled against the sandbox. */
      console.warn("pesapal: RequestToken was rejected for the " + this.environment(env) + " environment"
        + (res.status ? (" (HTTP " + res.status + ")") : ""));
      throw err(409, "Pesapal did not accept these credentials. Check the consumer key and secret.", "PESAPAL_AUTH_FAILED");
    }
    return d.token;
  },
  async registerIpn(env, creds, url){
    const token = await this.token(env, creds);
    const res = await providerFetch(this.base(env) + "/URLSetup/RegisterIPN", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: url, ipn_notification_type: "POST" })
    });
    const d = res.data || {};
    if(!res.ok || !d.ipn_id){
      throw err(409, "Pesapal did not register the notification URL. Please try again.", "PESAPAL_IPN_FAILED");
    }
    return String(d.ipn_id);
  },
  async initiate(ctx){
    const token = await this.token(ctx.env, ctx.creds);
    let ipnId = ctx.creds.ipn_id;
    if(!ipnId){
      const ipnUrl = new URL(ctx.request.url).origin + "/api/webhooks/pesapal";
      ipnId = await this.registerIpn(ctx.env, ctx.creds, ipnUrl);
      /* Keep it: a registered IPN id is what makes the callback arrive, and
         re-registering one on every checkout would be both slow and noisy. */
      await rememberProviderField(ctx.env, "pesapal", ctx.organizer_id, "ipn_id", ipnId);
    }
    const parts = String(ctx.order.customer_name || "").trim().split(/\s+/);
    const res = await providerFetch(this.base(ctx.env) + "/Transactions/SubmitOrderRequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        id: ctx.reference,
        currency: this.currency,
        amount: Number(ctx.order.total_amount),
        description: "TicketHub order " + ctx.order.order_number,
        callback_url: ctx.callback_url,
        notification_id: ipnId,
        billing_address: {
          email_address: ctx.order.customer_email,
          phone_number: ctx.order.customer_phone || "",
          country_code: "KE",
          first_name: parts[0] || "Ticket",
          last_name: parts.slice(1).join(" ") || "Holder"
        }
      })
    });
    const d = res.data || {};
    if(!res.ok || !d.redirect_url || !d.order_tracking_id){
      throw err(409, "The payment provider could not start this checkout. Please try again shortly.", "PESAPAL_INIT_FAILED");
    }
    return {
      checkout_url: d.redirect_url,
      provider_ref: String(d.order_tracking_id),
      snapshot: { order_tracking_id: d.order_tracking_id, merchant_reference: d.merchant_reference }
    };
  },
  async statusFor(env, creds, trackingId){
    const token = await this.token(env, creds);
    const res = await providerFetch(this.base(env) + "/Transactions/GetTransactionStatus?orderTrackingId=" + encodeURIComponent(trackingId), {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" }
    });
    return res.data || {};
  },
  async verify(ctx){
    const d = await this.statusFor(ctx.env, ctx.creds, ctx.trackingId);
    const code = Number(d.status_code);
    let status = "pending";
    if(code === 1) status = "success";
    else if(code === 2) status = "failed";
    else if(code === 3) status = "failed";        // reversed
    else if(code === 0) status = "pending";       // invalid / not final yet
    if(d.error) status = "error";
    return {
      status: status,
      amount: d.amount != null ? Math.round(Number(d.amount)) : null,
      currency: d.currency || this.currency,
      provider_ref: String(ctx.trackingId),
      reference: d.merchant_reference || null,
      snapshot: {
        status_code: d.status_code,
        payment_status_description: d.payment_status_description,
        amount: d.amount, currency: d.currency, payment_method: d.payment_method,
        merchant_reference: d.merchant_reference, confirmation_code: d.confirmation_code
      }
    };
  },
  async test(ctx){
    const where = this.environment(ctx.env);
    try {
      await this.token(ctx.env, ctx.creds);
      return { ok: true, message: "Pesapal accepted these credentials in the " + where + " environment." };
    } catch(e){
      return { ok: false, message: "Pesapal rejected these credentials in the " + where + " environment. "
        + "Sandbox and live are separate Pesapal accounts: live keys only work while PESAPAL_ENV is set to \"live\" "
        + "on the Worker, and sandbox keys while it is unset." };
    }
  },
  /* capabilities drive the UI and refundPayment(), they are never assumed. */
  capabilities: { redirect: true, stk_push: false, test: true, refunds: false, webhook_signature: "provider_reverification" },
  /* A Pesapal IPN carries no signature of its own. Authenticity is established
     by the follow-up GetTransactionStatus call plus the merchant-reference match
     in the webhook route, so this honestly reports "not signature verified". */
  verifyWebhook(){ return { verified: false, reason: "unsigned_provider_reverification" }; }
};

/* --------------------------------------------------------------- paystack ---
   Amounts: Paystack expects the subunit, so whole shillings are multiplied by
   100 here and divided by 100 again when verifying. The D1 value stays KES. */
const PaystackProvider = {
  key: "paystack",
  label: "Paystack",
  api: "https://api.paystack.co",
  currency: "KES",
  async initiate(ctx){
    const secret = ctx.creds.secret;
    const res = await providerFetch(this.api + "/transaction/initialize", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: ctx.order.customer_email,
        amount: Number(ctx.order.total_amount) * 100,
        currency: this.currency,
        reference: ctx.reference,
        callback_url: ctx.callback_url,
        metadata: {
          order_number: ctx.order.order_number,
          order_id: ctx.order.id,
          event_id: ctx.order.event_id,
          organizer_id: ctx.order.organizer_id,
          customer_name: ctx.order.customer_name,
          customer_phone: ctx.order.customer_phone
        }
      })
    });
    const body = res.data || {};
    const d = body.data || {};
    if(!res.ok || !body.status || !d.authorization_url){
      throw err(409, "The payment provider could not start this checkout. Please try again shortly.", "PAYSTACK_INIT_FAILED");
    }
    return {
      checkout_url: d.authorization_url,
      provider_ref: d.reference != null ? String(d.reference) : ctx.reference,
      snapshot: { reference: d.reference, access_code: d.access_code }
    };
  },
  /* Always re-verified with the secret key; the browser's return trip means
     nothing on its own. */
  async verify(ctx){
    const res = await providerFetch(this.api + "/transaction/verify/" + encodeURIComponent(ctx.reference), {
      headers: { Authorization: "Bearer " + ctx.creds.secret, Accept: "application/json" }
    });
    const body = res.data || {};
    const t = body.data || {};
    const raw = String(t.status || "").toLowerCase();
    let status = "error";
    if(res.ok && body.status){
      if(raw === "success") status = "success";
      else if(raw === "abandoned") status = "abandoned";
      else if(raw === "failed" || raw === "reversed") status = "failed";
      else status = "pending";
    }
    return {
      status: status,
      amount: t.amount != null ? Math.round(Number(t.amount) / 100) : null,
      currency: t.currency || this.currency,
      provider_ref: t.id != null ? String(t.id) : null,
      reference: t.reference || ctx.reference,
      snapshot: {
        status: t.status, gateway_response: t.gateway_response, amount: t.amount,
        currency: t.currency, channel: t.channel, paid_at: t.paid_at, id: t.id
      }
    };
  },
  async webhookSignatureValid(rawBody, signature, creds){
    if(!signature) return false;
    const expected = await hmacSha512Hex(creds.secret, rawBody);
    return safeEqual(expected, String(signature).toLowerCase());
  },
  /* Shared callback verifier: the raw body and the signature header. `rejected`
     is what the unified callback processor treats as a hard 401. */
  async verifyWebhook(ctx){
    if(!ctx.signature) return { verified: false, rejected: true, reason: "missing_signature" };
    const okSignature = await this.webhookSignatureValid(ctx.raw_body, ctx.signature, ctx.creds);
    return { verified: okSignature, rejected: !okSignature, reason: "hmac_sha512" };
  },
  capabilities: { redirect: true, stk_push: false, test: true, refunds: false, webhook_signature: "hmac_sha512" },
  /* Validates provider credentials without creating a customer payment. */
  async test(ctx){
    const res = await providerFetch(this.api + "/balance", {
      headers: { Authorization: "Bearer " + ctx.creds.secret, Accept: "application/json" }
    });
    const body = res.data || {};
    if(res.ok && body.status) return { ok: true, message: "Paystack accepted these credentials." };
    return { ok: false, message: "Paystack rejected these credentials. Check the secret key and that it matches this environment." };
  }
};

/* --------------------------------------------------------------- payhero ----
   PayHero (https://payhero.co.ke) - Kenyan collections API, documented at
   https://docs.payhero.co.ke.

   Credentials (from the PayHero dashboard -> API Keys / Payment Channels):
     api_username  the API username of a created API key
     password      the API password (or the Basic Authorization token) - stored
                   AES-GCM encrypted and never returned to any client
     channel_id    the payment channel id (Payment Channels -> My Payment Channels)
   Authentication is HTTP Basic on every call. A request may also carry the
   optional `credential_id` of a merchant-owned Daraja credential, which is not
   needed for standard PayHero-managed channels.

   Two documented collection surfaces exist; this adapter uses the API one:
     POST /api/v2/payments                            STK push to the payer's phone
     GET  /api/v2/transaction-status?reference=...     authoritative status
   The hosted "Lipwa link" is an account-level share link rather than an API, so
   the STK push is used and the customer is not redirected at all: the checkout
   page waits for the phone prompt and polls the ORDINARY order status endpoint,
   which is verified against PayHero here.

   Amounts are whole KES on both sides (like Pesapal), so no subunit maths.
   ------------------------------------------------------------------------- */
const PAYHERO_DEFAULT_BASE = "https://backend.payhero.co.ke/api/v2";
const PAYHERO_TIMEOUT_MS = 20000;
const PayheroProvider = {
  key: "payhero",
  label: "PayHero",
  currency: "KES",
  capabilities: { redirect: false, stk_push: true, test: true, refunds: false, webhook_signature: "basic_auth_then_provider_reverification" },
  base(env){
    const configured = String((env && env.PAYHERO_BASE_URL) || "").trim();
    return (configured || PAYHERO_DEFAULT_BASE).replace(/\/+$/, "");
  },
  /* PayHero authenticates with HTTP Basic. The header is built here, used once,
     and never logged or returned to a client. */
  authHeader(creds){
    return "Basic " + base64Encode(utf8(String(creds.username || "") + ":" + String(creds.password || "")));
  },
  call(env, creds, method, endpoint, body){
    return providerFetch(this.base(env) + endpoint, {
      method: method,
      headers: Object.assign({ Authorization: this.authHeader(creds), Accept: "application/json" },
        body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }, PAYHERO_TIMEOUT_MS);
  },
  /* Kenya mobile numbers, normalised to the 2547XXXXXXXX shape PayHero expects
     (it also accepts 07XXXXXXXX; being explicit avoids a provider-side rejection). */
  normalizePhone(value){
    const digits = String(value || "").replace(/[^\d]/g, "");
    if(digits.length === 9 && digits.charAt(0) === "7") return "254" + digits;
    if(digits.length === 10 && digits.charAt(0) === "0") return "254" + digits.slice(1);
    if(digits.length === 12 && digits.slice(0, 3) === "254") return digits;
    return digits;
  },
  /* Starts a collection. There is no redirect URL: the payer approves the M-Pesa
     prompt, so the result carries mode "stk_push" and the frontend polls the
     ordinary order status endpoint. */
  async initiate(ctx){
    const creds = ctx.creds;
    const phone = this.normalizePhone(ctx.order.customer_phone);
    if(!phone) throw err(409, "This order has no phone number, so PayHero cannot prompt for payment.", "PAYHERO_NO_PHONE");
    const res = await this.call(ctx.env, creds, "POST", "/payments", {
      amount: Number(ctx.order.total_amount),
      phone_number: phone,
      channel_id: Number(creds.channel_id) || creds.channel_id,
      provider: "m-pesa",
      external_reference: ctx.order.order_number,
      customer_name: ctx.order.customer_name || undefined,
      callback_url: new URL(ctx.request.url).origin + "/api/webhooks/payhero"
    });
    const d = res.data || {};
    if(!res.ok || d.success === false){
      const providerMessage = String(d.error_message || d.message || d.detail || "").slice(0, 200);
      throw err(409, providerMessage || "The payment provider could not start this checkout. Please try again shortly.", "PAYHERO_INIT_FAILED");
    }
    const reference = String(d.reference || d.Reference || d.transaction_reference || "");
    return {
      /* No hosted page to redirect to: the checkout page waits on the phone. */
      checkout_url: null,
      mode: "stk_push",
      awaiting_customer: true,
      provider_ref: reference || null,
      snapshot: {
        status: d.status || null,
        reference: reference,
        checkout_request_id: d.CheckoutRequestID || d.checkout_request_id || null,
        channel_id: String(creds.channel_id),
        phone_last4: phone.slice(-4)
      }
    };
  },
  /* Authoritative status call. A PayHero callback is never trusted on its own:
     the state that settles an order always comes from here. */
  async statusFor(env, creds, reference){
    const res = await this.call(env, creds, "GET", "/transaction-status?reference=" + encodeURIComponent(String(reference)));
    return { res: res, data: res.data || {} };
  },
  async verify(ctx){
    const reference = ctx.trackingId || ctx.provider_ref || ctx.reference;
    const out = await this.statusFor(ctx.env, ctx.creds, reference);
    const d = out.data || {};
    const raw = String(d.status || d.Status || "").toUpperCase();
    let status = "error";
    if(out.res.ok && (d.status || d.status === 0)){
      if(raw === "SUCCESS") status = "success";
      else if(raw === "QUEUED" || raw === "PENDING" || raw === "INITIATED" || raw === "PROCESSING") status = "pending";
      else if(raw === "FAILED" || raw === "CANCELLED" || raw === "CANCELED" || raw === "REVERSED" || raw === "TIMEOUT") status = "failed";
      else if(raw === "ABANDONED") status = "abandoned";
      else status = "pending";
    }
    /* The PayHero status payload does not always carry the amount. When the
       caller supplies the callback's amount it is carried through, so the shared
       validatePayment() can still compare it with the stored order total. */
    const amount = (d.amount != null) ? Math.round(Number(d.amount))
      : ((d.Amount != null) ? Math.round(Number(d.Amount))
      : (ctx.callback_amount != null ? Math.round(Number(ctx.callback_amount)) : null));
    return {
      status: status,
      amount: amount,
      currency: this.currency,
      provider_ref: String(d.reference || d.third_party_reference || reference || "") || null,
      reference: ctx.reference || null,
      snapshot: {
        status: d.status || d.Status || null,
        success: d.success === undefined ? null : d.success,
        provider: d.provider || null,
        provider_reference: d.provider_reference || d.third_party_reference || null,
        mpesa_receipt: d.provider_reference || d.third_party_reference || null,
        checkout_request_id: d.CheckoutRequestID || null,
        merchant: d.merchant || null,
        amount: amount,
        transaction_date: d.transaction_date || null
      }
    };
  },
  /* PayHero POSTs the result of a collection to the callback_url we supplied.
     Its documented payload is:
       { forward_url, status: true, response: { Amount, CheckoutRequestID,
         ExternalReference, MerchantRequestID, MpesaReceiptNumber, Phone,
         ResultCode, ResultDesc, Status } }
     There is no documented HMAC signature, so authenticity is established in
     two steps: an Authorization header is checked when PayHero sends one (built
     from the same Basic credentials), and the transaction is ALWAYS re-verified
     with GET /transaction-status before any state changes. A callback alone can
     therefore never mark an order paid. */
  async verifyWebhook(ctx){
    const header = String(ctx.authorization || "");
    if(/^basic\s+/i.test(header)){
      const okHeader = safeEqual(this.authHeader(ctx.creds).toLowerCase(), header.trim().toLowerCase());
      /* Present but wrong is a hard reject; absent falls through to the
         mandatory provider re-verification, which is what really authenticates. */
      return { verified: okHeader, rejected: !okHeader, had_header: true, reason: okHeader ? "basic_auth_match" : "basic_auth_mismatch" };
    }
    return { verified: false, rejected: false, had_header: false, reason: "unsigned_provider_reverification" };
  },
  /* Reads the documented PayHero callback shape into the fields the unified
     callback processor needs. */
  readWebhookEvent(raw){
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch(e){ payload = null; }
    if(!payload || typeof payload !== "object") return null;
    const body = (payload.response && typeof payload.response === "object") ? payload.response : payload;
    const reference = body.ExternalReference || body.external_reference || payload.external_reference || "";
    const amount = (body.Amount != null) ? body.Amount : ((body.amount != null) ? body.amount : null);
    const statusText = String(body.Status || body.status || "").toUpperCase();
    const resultCode = (body.ResultCode != null) ? Number(body.ResultCode) : null;
    if(!reference) return null;
    /* PayHero reports the M-Pesa result: a non-zero ResultCode is a failed or
       cancelled prompt, never a success. */
    let outcome = "pending";
    if(statusText === "SUCCESS" && (resultCode === null || resultCode === 0)) outcome = "success";
    else if(statusText === "SUCCESS") outcome = "failed";
    else if(statusText === "FAILED" || statusText === "CANCELLED" || statusText === "CANCELED") outcome = "failed";
    return {
      reference: String(reference),
      amount: amount == null ? null : Math.round(Number(amount)),
      currency: this.currency,
      outcome: outcome,
      status_text: statusText || null,
      result_code: resultCode,
      /* Metadata only: CheckoutRequestID is NOT the PayHero reference, so it is
         never used to look a transaction up or to call transaction-status. */
      checkout_request_id: body.CheckoutRequestID || null,
      receipt: body.MpesaReceiptNumber || null,
      phone: body.Phone || null,
      forward_url: payload.forward_url || null
    };
  },
  /* Validates the credentials AND that the configured channel really exists on
     the account, which is the part that usually breaks a PayHero setup. */
  async test(ctx){
    const res = await this.call(ctx.env, ctx.creds, "GET", "/payment_channels?is_active=true");
    if(!res.ok) return { ok: false, message: "PayHero rejected these credentials. Check the API username and password (or the Basic Authorization token)." };
    const data = res.data || {};
    const channels = Array.isArray(data.payment_channels) ? data.payment_channels
      : (Array.isArray(data) ? data : []);
    const wanted = String(ctx.creds.channel_id);
    const match = channels.filter(c => String(c && c.id) === wanted)[0];
    if(channels.length && !match){
      return { ok: false, message: "PayHero accepted the credentials, but channel " + wanted + " is not an active channel on this account. Copy the id from Payment Channels -> My Payment Channels." };
    }
    return { ok: true, message: "PayHero accepted these credentials" + (match ? " and channel " + wanted + " is active." : ".") };
  }
};

function providerFor(key){
  const p = PROVIDERS[String(key || "").toLowerCase()];
  if(!p) throw err(400, "Unsupported payment provider.", "BAD_PROVIDER");
  return p;
}
/* Register more providers here: the order, webhook and check-in layers only
   ever talk to this map through PaymentService. */
const PROVIDERS = { paystack: PaystackProvider, pesapal: PesapalProvider, payhero: PayheroProvider };

/* ============================================================================
   PAYMENT SETTLEMENT
   ----------------------------------------------------------------------------
   The only path that can mark an order paid. It re-verifies with the provider
   and refuses to issue tickets unless the amount, currency and reference all
   match what this server recorded.
   ========================================================================== */
async function settlePayment(env, order, payment, provider, creds, trackingRef, request, task, hints){
  const verification = await provider.verify({
    env: env, creds: creds, reference: payment.reference, trackingId: trackingRef || payment.provider_ref,
    callback_amount: (hints && hints.callback_amount != null) ? hints.callback_amount : null
  });
  if(verification.status === "success"){
    /* Shared amount/currency validation: one implementation for all providers. */
    const check = PaymentService.validatePayment(order, verification);
    if(!check.ok){
      await dbRun(env, "UPDATE payments SET status = 'failed', failure_reason = ?, failure_at = COALESCE(failure_at, ?), provider_response = ?, updated_at = ? WHERE id = ? AND status != 'success'",
        [check.mismatch + "_mismatch", touch(),
         JSON.stringify({ reason: check.mismatch + "_mismatch", expected: check.expected, reported: check.reported }).slice(0, 4000), touch(), payment.id]);
      return { settled: false, mismatch: check.mismatch, verification: verification };
    }
    const done = await markOrderPaid(env, order, payment, verification.provider_ref, verification.snapshot, request, task);
    return { settled: true, first_time: done.first_time, order: done.order, tickets: done.tickets, verification: verification };
  }
  if(verification.status === "failed" || verification.status === "abandoned"){
    await failOrder(env, order, payment, verification.snapshot, request, task, verification.status);
    return { settled: false, failed: true, verification: verification };
  }
  await dbRun(env, "UPDATE payments SET provider_response = ?, provider_metadata = COALESCE(provider_metadata, ?), updated_at = ? WHERE id = ?",
    [JSON.stringify(verification.snapshot || {}).slice(0, 4000), metadataFor(payment.provider, verification.snapshot), touch(), payment.id]);
  return { settled: false, pending: true, verification: verification };
}
async function uniqueOrderNumber(env){
  for(let attempt = 0; attempt < 6; attempt++){
    const candidate = orderNumber();
    const clash = await dbGet(env, "SELECT id FROM orders WHERE order_number = ?", [candidate]);
    if(!clash) return candidate;
  }
  return "PAT-" + randomCode(14);
}
/* ------------------------------------------------------ POST /api/orders ---- */
/* Public: customers buy without an account. Every price, availability figure
   and total is taken from D1 - nothing is trusted from the browser. */
async function routeCreateOrder(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  /* Per-IP checkout limit, counted BEFORE the challenge so a flood never costs a
     Siteverify round trip. The per-order tier is added by the payment route,
     which is the only call that knows the reference. */
  await guardRate(env, request, "checkout", { skip: ["ref"] });
  await requireTurnstile(env, request, body, "checkout");
  await releaseExpiredOrders(env);

  const eventId = vInt(body.event_id, "event", { min: 1, label: "Event" });
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [eventId]);
  if(!ev) throw err(404, "This event is no longer available.", "NOT_FOUND");
  if(String(ev.status) !== "active") throw err(409, "Tickets for this event are not on sale right now.", "NOT_ON_SALE");
  /* event_date and the sale window are Kenyan calendar dates, so they are
     compared with the Kenyan day - never with UTC's (21:00 in Nairobi is
     already tomorrow in UTC). */
  const today = keToday();
  if(String(ev.event_date).slice(0, 10) < today) throw err(409, "This event has already taken place.", "EVENT_ENDED");
  if(ev.sales_end && String(ev.sales_end).slice(0, 10) < today) throw err(409, "Ticket sales for this event have closed.", "SALES_CLOSED");
  if(ev.sales_start && String(ev.sales_start).slice(0, 10) > today) throw err(409, "Ticket sales for this event have not opened yet.", "SALES_NOT_OPEN");

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if(!rawItems.length) throw err(422, "Choose at least one ticket before continuing.", "VALIDATION");
  if(rawItems.length > 12) throw err(422, "There are too many different ticket types in this order.", "VALIDATION");
  const wanted = new Map();
  for(const it of rawItems){
    const typeId = vInt(it && it.ticket_type_id, "ticket type", { min: 1, label: "Ticket type" });
    const qty = vInt(it && it.quantity, "quantity", { min: 1, label: "Quantity" });
    if(qty > 100) throw err(422, "You cannot buy more than 100 of one ticket type in a single order.", "VALIDATION");
    wanted.set(typeId, (wanted.get(typeId) || 0) + qty);
  }

  const customer = body.customer || {};
  const name = vStr(customer.full_name || body.customer_name, "full name", { required: true, min: 3, max: 120, label: "Full name" });
  const email = vEmail(customer.email || body.customer_email, "email address", true);
  const phone = vPhone(customer.phone || body.customer_phone, "phone number", true);

  const claimed = [], items = [];
  let total = 0;
  try {
    for(const pair of wanted){
      const typeId = pair[0], qty = pair[1];
      const tt = await dbGet(env, "SELECT * FROM ticket_types WHERE id = ? AND event_id = ?", [typeId, ev.id]);
      if(!tt) throw err(404, "One of the selected ticket types is no longer available.", "TICKET_TYPE_GONE");
      if(!ticketOnSale(tt)){
        const available = Math.max(0, Number(tt.quantity) - Number(tt.sold));
        if(available <= 0) throw err(409, tt.name + " is sold out.", "SOLD_OUT");
        throw err(409, tt.name + " is not on sale right now.", "NOT_ON_SALE");
      }
      if(!(await reserveStock(env, tt.id, qty))){
        const available = Math.max(0, Number(tt.quantity) - Number(tt.sold));
        throw err(409, available > 0 ? ("Only " + available + " left for " + tt.name + ".") : (tt.name + " is sold out."), "SOLD_OUT");
      }
      claimed.push({ id: tt.id, qty: qty });
      const unit = Number(tt.price);
      total += unit * qty;
      items.push({ ticket_type_id: tt.id, ticket_type_name: tt.name, quantity: qty, unit_price: unit, subtotal: unit * qty });
    }

    const orderNo = await uniqueOrderNumber(env);
    const ins = await dbRun(env,
      "INSERT INTO orders (order_number, event_id, organizer_id, customer_name, customer_email, customer_phone, total_amount, currency, status, inventory_held) VALUES (?,?,?,?,?,?,?,?,'pending',1)",
      [orderNo, ev.id, ev.organizer_id, name, email, phone, total, "KES"]);
    const orderId = (ins && ins.meta && ins.meta.last_row_id) ? ins.meta.last_row_id : null;
    if(!orderId) throw err(500, "We could not create your order. Please try again.", "ORDER_FAILED");
    for(const it of items){
      await dbRun(env, "INSERT INTO order_items (order_id, ticket_type_id, ticket_type_name, quantity, unit_price, subtotal) VALUES (?,?,?,?,?,?)",
        [orderId, it.ticket_type_id, it.ticket_type_name, it.quantity, it.unit_price, it.subtotal]);
    }
    /* One resolver decides which provider serves this event: the event's own
       override when it is configured, otherwise the organizer's active
       provider. No provider is ever substituted for another one. */
    const resolved = await resolveEffectiveProvider(env, { event: ev });
    const providerKey = resolved.provider_key || providerKeyOf(resolved.settings);
    const creds = resolved.creds;
    await dbRun(env, "INSERT INTO payments (order_id, provider, reference, amount, currency, status) VALUES (?,?,?,?,?,'pending')",
      [orderId, providerKey, orderNo, total, "KES"]);
    /* Freeze the money trail on the order: who collects it + which gateway.
       A later payment_mode flip changes future orders only, never this one. */
    await stampOrderMoneyTrail(env, orderId, resolved, providerKey);
    const order = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
    const payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [orderId]);
    /* The buyer gets a written trail even if they never finish paying. Free
       orders skip this: they are settled at the next step and get tickets. */
    if(total > 0) await sendOrderPendingEmail(env, order, request, ctx.ctx);
    /* The payment step of this same checkout is authorised by this receipt
       (see checkoutProofIssue): a Turnstile token is single use, so it cannot
       be replayed on /api/payments/:provider/initiate. */
    const proof = await checkoutProofIssue(env, order.order_number, clientIp(request));
    return created({
      order: orderPayload(order, items, payment, []),
      provider: providerKey,
      provider_label: providerLabel(providerKey),
      provider_ready: !!creds,
      payment_configured: !!creds,
      /* Safe, actionable wording for the organizer; the customer only ever sees
         this when the event cannot take money yet. */
      payment_message: creds ? null : providerProblemMessage(resolved),
      checkout_proof: proof
    });
  } catch(e){
    for(const c of claimed) await releaseStock(env, c.id, c.qty);
    throw e;
  }
}
/* ------------------------------------------- POST /api/payments/:p/initiate -
   The frontend never sends an amount: the Worker loads the order, checks that
   the organizer really sells through this provider and asks the provider for a
   checkout URL. */
async function routeInitiatePayment(ctx){
  const env = ctx.env, request = ctx.request, providerKey = ctx.params.provider;
  const provider = providerFor(providerKey);
  const body = await readJson(request);
  const reference = vStr(body.reference || body.order_number, "reference", { required: true, max: 60, label: "Order reference" });
  /* Per-IP AND per-order-reference checkout limits, before the challenge and
     before the order is looked up: one order cannot be re-initiated in a loop
     and one host cannot drive the provider endpoint. */
  await guardRate(env, request, "checkout", { ref: reference });
  const order = await dbGet(env, "SELECT * FROM orders WHERE order_number = ?", [reference]);
  if(!order) throw err(404, "We could not find that order. Please start again.", "NOT_FOUND");
  /* Checkout protection: the receipt handed out with this order by
     POST /api/orders (a Turnstile verification, bound to this order and this
     client) authorises the payment step; anything else must present a fresh
     single-use Turnstile token. Nothing is payable without one of the two. */
  if(!(await checkoutProofValid(env, body.checkout_proof, order.order_number, clientIp(request)))){
    await requireTurnstile(env, request, body, "checkout");
  }
  if(body.order_id != null && Number(body.order_id) !== Number(order.id)){
    throw err(409, "That order reference does not match this order.", "ORDER_MISMATCH");
  }
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [order.event_id]);
  /* ONE resolver, one priority order: event override (when configured) ->
     organizer active provider -> "not configured". Never another gateway. */
  const resolved = await resolveEffectiveProvider(env, { event: ev });
  const expected = resolved.provider_key || providerKeyOf(resolved.settings);
  if(expected !== providerKey){
    throw err(409, "This organizer sells through " + providerLabel(expected) + ".", "PROVIDER_MISMATCH");
  }
  const creds = resolved.creds;
  if(!creds){
    /* No silent fallback: the organizer gets the actionable sentence, the buyer
       gets a safe one without any infrastructure detail. */
    throw err(409, providerProblemMessage(resolved), "PROVIDER_NOT_CONNECTED");
  }
  const payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  if(!payment) throw err(500, "This order has no payment record. Please start again.", "NO_PAYMENT");
  const items = await orderItemsFor(env, order.id);
  const callbackUrl = callbackUrlFor(env, request, order.order_number);
  if(order.status === "paid"){
    return ok({ already_paid: true, authorization_url: callbackUrl, checkout_url: callbackUrl,
      order: orderPayload(order, items, payment, []), provider: providerKey });
  }
  if(order.status === "cancelled" || order.status === "failed"){
    throw err(409, "This order can no longer be paid. Please start a new order.", "ORDER_CLOSED");
  }
  /* Free ticket types never touch the provider: the order is settled directly
     and the customer is sent to the confirmation page. When the event has email
     verification on (the default), ONLY an order created by the verified
     /api/tickets/free/register flow carries an active claim row - so a free order
     that came from anywhere else is refused here rather than issuing an
     unverified free ticket. */
  if(Number(order.total_amount) <= 0){
    const freeCfg = freeTicketConfig(ev);
    if(freeCfg.otp_enabled){
      const claim = await dbGet(env, "SELECT id FROM free_ticket_claims WHERE order_id = ? AND status = 'active'", [order.id]);
      if(!claim){
        throw err(403, "Free tickets on this event must be claimed with email verification. Please register from the event page.", "FREE_VERIFICATION_REQUIRED");
      }
    }
    const done = await markOrderPaid(env, order, payment, null, { free_order: true }, request, ctx.ctx);
    return ok({ free: true, authorization_url: callbackUrl, checkout_url: callbackUrl,
      order: orderPayload(done.order, items, payment, []), provider: providerKey });
  }
  const result = await PaymentService.createPayment({
    env: env, request: request, order: order, reference: payment.reference,
    callback_url: callbackUrl, creds: creds, settings: resolved.settings, provider_key: providerKey,
    /* The organizer is part of the context so a provider can store something it
       learned at runtime (the Pesapal IPN id) in the right row. */
    organizer_id: resolved.organizer_id
  });
  await dbRun(env, "UPDATE payments SET provider_ref = COALESCE(?, provider_ref), provider_response = ?, provider_metadata = COALESCE(provider_metadata, ?), updated_at = ? WHERE id = ?",
    [result.provider_ref || null, JSON.stringify(result.snapshot || {}).slice(0, 4000),
     metadataFor(providerKey, result.snapshot), touch(), payment.id]);
  const fresh = await dbGet(env, "SELECT * FROM payments WHERE id = ?", [payment.id]);
  return ok({
    authorization_url: result.checkout_url || null,
    checkout_url: result.checkout_url || null,
    /* PayHero collects by prompting the payer's phone instead of redirecting, so
       the checkout page needs to know to wait and poll rather than navigate. */
    mode: result.mode || "redirect",
    awaiting_customer: !!result.awaiting_customer,
    status_url: "/api/payments/" + encodeURIComponent(payment.reference),
    reference: payment.reference,
    provider: providerKey,
    provider_label: providerLabel(providerKey),
    order: orderPayload(order, items, fresh, [])
  });
}
/* ------------------------------------------- POST /api/payments/create ------
   The provider-neutral entry point: the client never picks a gateway, the
   server resolves it for the event. Identical to
   POST /api/payments/:provider/initiate, which stays for compatibility. */
async function routePaymentCreate(ctx){
  const env = ctx.env, request = ctx.request;
  /* The body is read once here and again by the shared handler, so the request
     is cloned first - the inner handler then sees the original payload. */
  const forHandler = request.clone();
  const body = await readJson(request);
  const reference = vStr(body.reference || body.order_number, "reference", { required: true, max: 60, label: "Order reference" });
  const order = await dbGet(env, "SELECT * FROM orders WHERE order_number = ?", [reference]);
  if(!order) throw err(404, "We could not find that order. Please start again.", "NOT_FOUND");
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [order.event_id]);
  const resolved = await resolveEffectiveProvider(env, { event: ev });
  const providerKey = resolved.provider_key || providerKeyOf(resolved.settings);
  const requested = vStr(body.provider, "provider", { max: 24 });
  if(requested && requested.toLowerCase() !== providerKey){
    throw err(409, "This organizer sells through " + providerLabel(providerKey) + ".", "PROVIDER_MISMATCH");
  }
  return routeInitiatePayment(Object.assign({}, ctx, {
    request: forHandler,
    params: Object.assign({}, ctx.params, { provider: providerKey })
  }));
}
function qrUrlFor(request, ticketNumberValue){
  return new URL(request.url).origin + "/api/tickets/" + encodeURIComponent(ticketNumberValue) + "/qr.png";
}

/* ============================================================================
   EMAIL PLUMBING
   ----------------------------------------------------------------------------
   Everything the templates need is assembled here, from D1 only (never from the
   browser), and then handed to emails.js. Sending is always best-effort: a mail
   problem is logged and recorded in email_outbox, never thrown at the customer.
   ========================================================================== */
const EMAIL_QR_ATTACHMENT_LIMIT = 10;
const EMAIL_ATTENDEE_NOTIFY_LIMIT = 200;
function emailRecipient(value){
  const s = String(value == null ? "" : value).trim();
  return EMAIL_RE.test(s) && s.length <= 190 ? s.toLowerCase() : "";
}
function appBase(env, request){
  const configured = String(env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if(/^https?:\/\//i.test(configured)) return configured;
  /* Never fall back to the Worker origin: every link built from appBase()
     (email buttons, footer nav, tickets_url) must open a real page on the
     production site, not an API-only domain. */
  return PRODUCTION_FRONTEND_URL;
}
function emailLinks(env, request, ev){
  const base = appBase(env, request);
  const page = (name, query) => (base ? base + "/" + name + (query || "") : "");
  return {
    base: base,
    home: page(""),
    events: page("events/"),
    contact: page("contact/"),
    support: page("contact/"),
    terms: page("terms/"),
    privacy: page("privacy/"),
    organizer: page("organizer-dashboard/"),
    create_event: page("create-event/"),
    owner: page("owner-dashboard/"),
    owner_events: page("owner-events/"),
    settings: page("organizer-settings/"),
    agreement: page("organizer-agreement/"),
    event: ev ? page("event/", "?slug=" + encodeURIComponent(ev.slug)) : "",
    ticket_base: page("ticket/", "?ticket=")
  };
}
async function emailBrandFor(env){
  return brandOf(await loadEmailSettings(env));
}
function eventEmailPayload(ev, org, links){
  if(!ev) return {};
  return {
    title: ev.title, slug: ev.slug, category: ev.category,
    date: ev.event_date, time: ev.start_time, end_time: ev.end_time,
    venue: ev.venue, location: ev.location, poster_url: ev.poster_url,
    url: links.event,
    organizer_name: org ? (org.business_name || "") : "",
    organizer_email: org ? (org.business_email || "") : "",
    organizer_phone: org ? (org.business_phone || "") : ""
  };
}
/* One canonical payload for every order email (customer, organizer, resend). */
async function orderEmailPayload(env, order, request, opts){
  const o = opts || {};
  const items = await orderItemsFor(env, order.id);
  const rows = await dbAll(env, TICKET_SELECT + " WHERE t.order_id = ? ORDER BY t.id ASC", [order.id]);
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [order.event_id]);
  const org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [order.organizer_id]);
  const payment = await dbGet(env, "SELECT provider FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  const links = emailLinks(env, request, ev);
  if(links.base) links.order = links.base + "/ticket/?order=" + encodeURIComponent(order.order_number);
  const withQr = o.with_qr !== false && rows.length <= EMAIL_QR_ATTACHMENT_LIMIT;
  return {
    brand: await emailBrandFor(env),
    links: links,
    customer: {
      name: order.customer_name || "",
      email: order.customer_email || "",
      phone: order.customer_phone || ""
    },
    order: {
      number: order.order_number,
      reference: order.order_number,
      status: order.status,
      amount: Number(order.total_amount),
      currency: order.currency || "KES",
      paid_at: order.paid_at,
      created_at: order.created_at,
      provider_label: payment ? (PROVIDER_LABELS[payment.provider] || payment.provider) : ""
    },
    event: eventEmailPayload(ev, org, links),
    items: items.map(it => ({
      name: it.ticket_type_name || "Ticket",
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
      subtotal: Number(it.subtotal)
    })),
    tickets: rows.map(t => ({
      number: t.ticket_number,
      type: t.ticket_type_name || "Ticket",
      attendee: t.attendee_name,
      status: t.status,
      qr_url: qrUrlFor(request, t.ticket_number),
      qr_base64: withQr ? base64Encode(qrPngBytes(t.qr_token)) : ""
    }))
  };
}
/* Customer confirmation + organizer sale alert. Runs once per paid order. */
async function sendOrderPaidEmails(env, order, request, task){
  try {
    const payload = await orderEmailPayload(env, order, request);
    const to = emailRecipient(order.customer_email);
    if(to){
      await queueEmail(env, {
        to: to, to_name: order.customer_name, template: "ticket_ready",
        dedupe_key: "ticket_ready:" + order.order_number, payload: payload
      });
    }
    const org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [order.organizer_id]);
    if(org){
      const owner = await dbGet(env, "SELECT full_name, email FROM users WHERE id = ?", [org.user_id]);
      const salesTo = emailRecipient(org.business_email) || emailRecipient(owner && owner.email);
      if(salesTo){
        await queueEmail(env, {
          to: salesTo, to_name: (owner && owner.full_name) || org.business_name || "", template: "new_sale",
          dedupe_key: "new_sale:" + order.order_number,
          /* the organizer does not need the QR images by email */
          payload: Object.assign({}, payload, {
            tickets: (payload.tickets || []).map(t => ({ number: t.number, type: t.type, attendee: t.attendee, status: t.status }))
          })
        });
      }
    }
    await dispatchSoon(env, task, 8);
  } catch(e){
    console.error("EMAIL_ORDER_ERROR", order ? order.order_number : "-", (e && e.message) || String(e));
  }
}
async function sendOrderPendingEmail(env, order, request, task){
  try {
    const to = emailRecipient(order.customer_email);
    if(!to) return;
    await queueEmail(env, {
      to: to, to_name: order.customer_name, template: "order_pending",
      dedupe_key: "order_pending:" + order.order_number,
      payload: await orderEmailPayload(env, order, request, { with_qr: false })
    });
    await dispatchSoon(env, task, 4);
  } catch(e){
    console.error("EMAIL_PENDING_ERROR", order ? order.order_number : "-", (e && e.message) || String(e));
  }
}
async function sendPaymentFailedEmail(env, order, request, task, reason){
  try {
    const to = emailRecipient(order.customer_email);
    if(!to) return;
    const payload = await orderEmailPayload(env, order, request, { with_qr: false });
    payload.reason = reason || "";
    await queueEmail(env, {
      to: to, to_name: order.customer_name, template: "payment_failed",
      dedupe_key: "payment_failed:" + order.order_number, payload: payload
    });
    await dispatchSoon(env, task, 4);
  } catch(e){
    console.error("EMAIL_FAILED_ERROR", order ? order.order_number : "-", (e && e.message) || String(e));
  }
}
/* Explicit resend (ticket.html / payment-success.html). No dedupe key: the
   customer asked for it. */
async function sendTicketResendEmail(env, order, request, to, task){
  const payload = await orderEmailPayload(env, order, request);
  const queued = await queueEmail(env, { to: to, to_name: order.customer_name, template: "ticket_resend", payload: payload });
  let delivery = null;
  if(queued.queued) delivery = await dispatchSoon(env, task, 4);
  return Object.assign({}, queued, { delivery: delivery });
}
async function sendWelcomeEmail(env, user, org, request, task){
  try {
    const to = emailRecipient(user && user.email);
    if(!to) return;
    await queueEmail(env, {
      to: to, to_name: (user && user.full_name) || "", template: "welcome",
      dedupe_key: "welcome:" + (user && user.id),
      payload: {
        brand: await emailBrandFor(env),
        links: emailLinks(env, request, null),
        customer: { name: (user && user.full_name) || "", email: to, phone: (user && user.phone) || "" },
        meta: { organizer_id: org ? org.id : null, business_name: org ? (org.business_name || "") : "" }
      }
    });
    await dispatchSoon(env, task, 4);
  } catch(e){
    console.error("EMAIL_WELCOME_ERROR", (e && e.message) || String(e));
  }
}
/* Event lifecycle mail. Cancelling is the important one: every buyer with a
   paid order is told, grouped into one email per order. */
async function notifyEventStatusEmail(env, ev, previous, next, request, task, reason){
  try {
    const status = String(next || "");
    if(!ev || !status || status === String(previous || "")) return { queued: 0 };
    if(status !== "active" && status !== "cancelled") return { queued: 0 };
    const brand = await emailBrandFor(env);
    const links = emailLinks(env, request, ev);
    const org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [ev.organizer_id]);
    const owner = org ? await dbGet(env, "SELECT id, full_name, email FROM users WHERE id = ?", [org.user_id]) : null;
    const organizerTo = emailRecipient(org && org.business_email) || emailRecipient(owner && owner.email);
    const organizerPayload = {
      brand: brand, links: links,
      event: eventEmailPayload(ev, org, links),
      customer: { name: (owner && owner.full_name) || "", email: organizerTo || "" },
      reason: reason || "",
      meta: { recipient: "organizer", status: status }
    };
    const stamp = String(ev.updated_at || "");
    if(status === "active"){
      if(organizerTo){
        await queueEmail(env, {
          to: organizerTo, to_name: (owner && owner.full_name) || "", template: "event_published",
          dedupe_key: "event_published:" + ev.id + ":" + stamp, payload: organizerPayload
        });
      }
      await dispatchSoon(env, task, 4);
      return { event: ev.id, status: status, queued: organizerTo ? 1 : 0 };
    }
    if(organizerTo){
      await queueEmail(env, {
        to: organizerTo, to_name: (owner && owner.full_name) || "", template: "event_cancelled",
        dedupe_key: "event_cancelled:" + ev.id + ":" + stamp, payload: organizerPayload
      });
    }
    const rows = await dbAll(env,
      "SELECT t.ticket_number, t.attendee_name, tt.name AS ticket_type_name, o.order_number, o.customer_name, o.customer_email, o.total_amount, o.currency " +
      "FROM tickets t JOIN orders o ON o.id = t.order_id LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id " +
      "WHERE t.event_id = ? AND o.status = 'paid' ORDER BY o.id ASC LIMIT 5000", [ev.id]);
    const grouped = new Map();
    for(const r of rows){
      const key = emailRecipient(r.customer_email);
      if(!key) continue;
      if(!grouped.has(key)){
        grouped.set(key, { name: r.customer_name, order: r.order_number, amount: Number(r.total_amount), currency: r.currency, tickets: [] });
      }
      grouped.get(key).tickets.push({ number: r.ticket_number, type: r.ticket_type_name || "Ticket" });
    }
    let queued = organizerTo ? 1 : 0, skipped = 0;
    for(const entry of grouped){
      if(queued >= EMAIL_ATTENDEE_NOTIFY_LIMIT){ skipped++; continue; }
      const info = entry[1];
      const result = await queueEmail(env, {
        to: entry[0], to_name: info.name, template: "event_cancelled",
        dedupe_key: "event_cancelled:" + ev.id + ":" + info.order,
        payload: {
          brand: brand, links: links,
          event: eventEmailPayload(ev, org, links),
          customer: { name: info.name, email: entry[0] },
          order: { number: info.order, amount: info.amount, currency: info.currency },
          tickets: info.tickets,
          reason: reason || "",
          meta: { recipient: "attendee" }
        }
      });
      if(result.queued) queued++; else skipped++;
    }
    await dispatchSoon(env, task, 25);
    return { event: ev.id, status: status, queued: queued, skipped: skipped };
  } catch(e){
    console.error("EMAIL_EVENT_STATUS_ERROR", ev ? ev.id : "-", (e && e.message) || String(e));
    return { error: String((e && e.message) || e) };
  }
}
/* ============================================================================
   EVENT APPROVAL
   ----------------------------------------------------------------------------
   Publishing is a two-step handshake. An organizer asking for "active" gives the
   Worker "pending" instead: the event is stored, nothing is public, and every
   active platform owner is emailed the request. Only an owner (PUT
   /api/owner/events/:id) can move it to "active" - and that approval emails the
   organizer through the ordinary event_published template.
   ========================================================================== */
/* The status an organizer's request is actually stored as. `ownerSelf` is the
   platform owner acting on their own event: the approver, so no queue. */
function organizerEventStatus(requested, ownerSelf){
  const status = String(requested || "draft");
  if(ownerSelf) return status;
  return status === "active" ? "pending" : status;
}
/* Everyone who runs the platform: role = "owner" and active, de-duplicated. This
   is the single source of truth for "the owner", shared by the approval queue and
   the contact-form notification, so both reach exactly the same people. */
async function platformOwnerRecipients(env){
  const out = [];
  try {
    const rows = await dbAll(env, "SELECT full_name, email FROM users WHERE role = 'owner' AND status = 'active' ORDER BY id ASC LIMIT 10");
    for(const r of rows){
      const to = emailRecipient(r.email);
      if(to && !out.some(x => x.to === to)) out.push({ to: to, name: r.full_name || "" });
    }
  } catch(e){
    console.error("EMAIL_OWNERS_ERROR", (e && e.message) || String(e));
  }
  return out;
}
/* The approval queue's inbox: every active platform owner. The platform support
   address is the fallback, so a request can never disappear when the owner row
   is missing or unreadable. */
async function approvalRecipients(env){
  const out = await platformOwnerRecipients(env);
  if(!out.length){
    const settings = await loadEmailSettings(env);
    const brand = brandOf(settings);
    const to = emailRecipient(settings.support_email) || emailRecipient(env.SUPPORT_EMAIL) || emailRecipient(brand.support_email);
    if(to) out.push({ to: to, name: brand.product + " administrators" });
  }
  return out;
}
/* Tells the owners that an event is waiting. Best-effort, like every other mail
   on the platform: a broken outbox never fails the organizer's save. */
async function notifyEventApprovalRequestEmail(env, ev, org, request, task){
  try {
    if(!ev) return { queued: 0 };
    /* The review mail always names the organizer, so fall back to the event's
       own organizer row when the caller did not already load it. */
    const owner = org || await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [ev.organizer_id]);
    const recipients = await approvalRecipients(env);
    if(!recipients.length){
      console.error("EMAIL_APPROVAL_NO_RECIPIENT", ev.id);
      return { queued: 0, skipped: "no_recipient" };
    }
    const brand = await emailBrandFor(env);
    const links = emailLinks(env, request, ev);
    const stamp = String(ev.updated_at || "");
    let queued = 0;
    for(const r of recipients){
      const result = await queueEmail(env, {
        to: r.to, to_name: r.name, template: "event_pending_approval",
        dedupe_key: "event_pending_approval:" + ev.id + ":" + stamp,
        payload: {
          brand: brand, links: links,
          event: eventEmailPayload(ev, owner, links),
          customer: { name: (owner && owner.business_name) || "", email: (owner && owner.business_email) || "" },
          meta: { recipient: "owner", status: "pending", submitted_at: stamp }
        }
      });
      if(result.queued) queued++;
    }
    if(queued) await dispatchSoon(env, task, 4);
    return { event: ev.id, status: "pending", queued: queued };
  } catch(e){
    console.error("EMAIL_APPROVAL_REQUEST_ERROR", ev ? ev.id : "-", (e && e.message) || String(e));
    return { queued: 0 };
  }
}
/* The owner sent a submitted event back instead of approving it. */
async function notifyEventChangesRequestedEmail(env, ev, request, task, reason){
  try {
    if(!ev) return { queued: 0 };
    const org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [ev.organizer_id]);
    const user = org ? await dbGet(env, "SELECT full_name, email FROM users WHERE id = ?", [org.user_id]) : null;
    const to = emailRecipient(org && org.business_email) || emailRecipient(user && user.email);
    if(!to) return { queued: 0 };
    const links = emailLinks(env, request, ev);
    await queueEmail(env, {
      to: to, to_name: (user && user.full_name) || (org && org.business_name) || "",
      template: "event_changes_requested",
      dedupe_key: "event_changes_requested:" + ev.id + ":" + String(ev.updated_at || ""),
      payload: {
        brand: await emailBrandFor(env),
        links: links,
        event: eventEmailPayload(ev, org, links),
        customer: { name: (user && user.full_name) || "", email: to },
        reason: reason || "",
        meta: { recipient: "organizer", status: "draft" }
      }
    });
    await dispatchSoon(env, task, 4);
    return { queued: 1 };
  } catch(e){
    console.error("EMAIL_CHANGES_REQUESTED_ERROR", ev ? ev.id : "-", (e && e.message) || String(e));
    return { queued: 0 };
  }
}
async function notifyOrganizerStatusEmail(env, org, status, request, task, reason){
  try {
    if(!org) return { queued: 0 };
    const user = await dbGet(env, "SELECT id, full_name, email FROM users WHERE id = ?", [org.user_id]);
    const to = emailRecipient(user && user.email) || emailRecipient(org.business_email);
    if(!to) return { queued: 0 };
    await queueEmail(env, {
      to: to, to_name: (user && user.full_name) || org.business_name || "", template: "organizer_status",
      dedupe_key: "organizer_status:" + org.id + ":" + status + ":" + String(org.updated_at || ""),
      payload: {
        brand: await emailBrandFor(env),
        links: emailLinks(env, request, null),
        customer: { name: (user && user.full_name) || "", email: to },
        reason: reason || "",
        meta: { status: status, organizer_id: org.id }
      }
    });
    await dispatchSoon(env, task, 4);
    return { queued: 1 };
  } catch(e){
    console.error("EMAIL_ORG_STATUS_ERROR", (e && e.message) || String(e));
    return { queued: 0 };
  }
}
/* Contact form: the same message goes to the platform support address AND to
   every active platform owner - so whoever can act on it is never left out - plus
   an acknowledgement to the person who wrote in. */
async function sendContactEmails(env, message, request, task){
  try {
    const settings = await loadEmailSettings(env);
    const brand = brandOf(settings);
    const payload = {
      brand: brand,
      links: emailLinks(env, request, null),
      message: message,
      customer: { name: message.name, email: message.email }
    };
    const supportTo = emailRecipient(settings.support_email) || emailRecipient(env.SUPPORT_EMAIL) || emailRecipient(brand.support_email);
    if(supportTo){
      await queueEmail(env, { to: supportTo, to_name: brand.product + " support", template: "contact_message", payload: payload });
    }
    /* The owners receive the identical message - sender, subject and full text,
       with the reply-to-sender and dashboard buttons - so they can act directly. */
    const ownersNotified = [];
    const owners = await platformOwnerRecipients(env);
    for(const owner of owners){
      if(!owner.to || owner.to === supportTo || ownersNotified.indexOf(owner.to) >= 0) continue;
      await queueEmail(env, { to: owner.to, to_name: owner.name || (brand.product + " owner"), template: "contact_message", payload: payload });
      ownersNotified.push(owner.to);
    }
    const senderTo = emailRecipient(message.email);
    if(senderTo){
      await queueEmail(env, { to: senderTo, to_name: message.name, template: "contact_ack", payload: payload });
    }
    await dispatchSoon(env, task, 4);
    return { support: supportTo || null, owners: ownersNotified, owner_notified: ownersNotified.length > 0, acknowledgement: senderTo || null };
  } catch(e){
    console.error("EMAIL_CONTACT_ERROR", (e && e.message) || String(e));
    return {};
  }
}
/* --------------------------------------------- GET /api/payments/:reference -
   Public order lookup used by the confirmation page. While the payment is still
   pending it asks the provider directly (still server-side); after that it
   answers from D1 only. */
async function routePaymentStatus(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "payment_status", {});
  const reference = vStr(ctx.params.reference, "reference", { required: true, max: 60 });
  const order = await dbGet(env, "SELECT * FROM orders WHERE order_number = ?", [reference]);
  if(!order) throw err(404, "We could not find that order. Check the reference and try again.", "NOT_FOUND");
  let payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  if(order.status === "pending" && payment && payment.provider_ref){
    /* Settlement always uses the credentials of the provider THIS transaction
       was created with, even if the organizer has since switched the active
       provider or disabled it - the customer may already have paid. */
    const settings = await loadPaymentSettings(env, order.organizer_id);
    /* The organizer of THIS order is named explicitly: the settlement must read
       the organizer's own provider row even when no payment_settings row exists,
       or a customer who already paid has an order that never settles. Legacy
       orders billed to the platform/shared account keep verifying via
       allowPlatform, keyed to the transaction's own provider - new checkout
       never creates such orders. */
    const txnCreds = await resolveCredentials(env, settings, payment.provider, { organizer_id: order.organizer_id, allowPlatform: true });
    const creds = txnCreds;
    if(creds){
      try { await settlePayment(env, order, payment, providerFor(payment.provider), creds, payment.provider_ref, request, ctx.ctx); }
      catch(e){ /* stay pending; the webhook stays the authority */ }
    }
  }
  const freshOrder = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [order.id]);
  payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  const items = await orderItemsFor(env, order.id);
  const rows = await dbAll(env, TICKET_SELECT + " WHERE t.order_id = ? ORDER BY t.id ASC", [order.id]);
  const listed = rows.map(t => ticketPayload(t, { qr_image_url: qrUrlFor(request, t.ticket_number) }));
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [order.event_id]);
  const org = await dbGet(env, "SELECT business_name, logo_url FROM organizers WHERE id = ?", [order.organizer_id]);
  const payload = orderPayload(freshOrder, items, payment, listed);
  payload.event = ev ? publicEvent(ev) : null;
  payload.event_title = ev ? ev.title : null;
  payload.organizer_name = org ? org.business_name : null;
  return ok(Object.assign({}, payload, {
    order: payload,
    status: freshOrder.status,
    payment: payment ? {
      provider: payment.provider,
      provider_label: providerLabel(payment.provider),
      reference: payment.reference,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      paid_at: payment.paid_at,
      failed_at: payment.failure_at || null,
      /* Never the raw provider payload: only the whitelisted metadata. */
      metadata: safeProviderMetadata(payment.provider, payment.provider_metadata)
    } : null
  }));
}
/* GET /api/payments/:id/status - the id-or-reference spelling of
   GET /api/payments/:reference, which stays for compatibility. Same handler,
   same verification, same answer. */
async function routePaymentStatusById(ctx){
  return routePaymentStatus(Object.assign({}, ctx, {
    params: Object.assign({}, ctx.params, { reference: ctx.params.id || ctx.params.reference })
  }));
}
/* ------------------------------------ GET /api/orders/:reference/tickets ---
   Public: a customer who only has their order number can reload their tickets. */
/* The shared answer behind both order-ticket reads: the order's summary plus its
   issued tickets, each carrying a server-built QR url - the opaque token inside
   the QR is never part of the payload. */
async function orderTicketsView(env, request, order){
  const rows = await dbAll(env, TICKET_SELECT + " WHERE t.order_id = ? ORDER BY t.id ASC", [order.id]);
  const listed = rows.map(t => ticketPayload(t, { qr_image_url: qrUrlFor(request, t.ticket_number) }));
  const ev = await dbGet(env, "SELECT title, event_date, start_time, venue, location, poster_url FROM events WHERE id = ?", [order.event_id]);
  return {
    order_number: order.order_number,
    status: order.status,
    customer_name: order.customer_name,
    amount: Number(order.total_amount),
    ticket_count: listed.length,
    event_title: ev ? ev.title : null,
    event: ev || null,
    tickets: listed
  };
}
async function routeOrderTickets(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "order_tickets", {});
  const reference = vStr(ctx.params.reference, "reference", { required: true, max: 60 });
  const order = await dbGet(env, "SELECT * FROM orders WHERE order_number = ?", [reference]);
  if(!order) throw err(404, "We could not find that order.", "NOT_FOUND");
  return ok(await orderTicketsView(env, request, order));
}

/* ------------------------------------ POST /api/orders/lookup -------------
   Public: check-ticket/index.html. The caller proves the order is theirs by
   naming the email address it was placed with. BOTH halves are checked here -
   the browser never sees the order until they match - and a wrong pair answers
   exactly like a missing order, so neither half can be probed against the
   other. Read-only like the other public reads, so guardRate is the abuse
   control rather than a Turnstile challenge: a per-IP tier per minute and per
   hour (both D1-backed, so a bot spread over many isolates gets no fresh
   allowance per isolate) plus a per-address tier, which makes guessing one half
   against the other expensive however many IPs are used. */
async function routeOrderLookup(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  await guardRate(env, request, "order_lookup", {
    ref: body.order_number || body.order || body.reference,
    email: body.email
  });
  const orderNumber = vStr(body.order_number || body.order || body.reference, "order number", { required: true, max: 64, label: "Order ID" });
  const email = vEmail(body.email, "email", true);
  /* Order IDs are generated as PAT-<10 uppercase chars> (randomCode), so a
     customer typing pat-... in an email app still finds their own order. */
  const order = await dbGet(env, "SELECT * FROM orders WHERE order_number = ?", [orderNumber.toUpperCase()]);
  const match = !!order && normaliseEmail(order.customer_email) === normaliseEmail(email);
  if(!match){
    throw err(404, "We could not find a ticket for that email address and Order ID. Check both and try again.", "NOT_FOUND");
  }
  return ok(await orderTicketsView(env, request, order));
}

/* ============================================================================
   PUBLIC ROUTES
   ========================================================================== */
/* Is the database at the schema this build expects? Each check is a query that
   only succeeds once the migration is applied, and a missing one is reported by
   name - with the file that fixes it - instead of as an unexplained failure.
   D1 runs statements in auto-commit, so a migration that stopped partway leaves
   the earlier statements applied: "the table is there but a column is not" is a
   real state, and the caller is told which of the two files to run. */
const PAYMENT_SCHEMA_CHECKS = [
  { what: "organizer_payment_providers", file: "0002_payhero.sql",  sql: "SELECT COUNT(*) AS n FROM organizer_payment_providers" },
  { what: "payments.provider_metadata",  file: "0002_payhero.sql",  sql: "SELECT provider_metadata FROM payments LIMIT 1" },
  { what: "payments.failure_reason",     file: "0002_payhero.sql",  sql: "SELECT failure_reason FROM payments LIMIT 1" },
  { what: "payments.failure_at",         file: "0003_payhero_repair.sql", sql: "SELECT failure_at FROM payments LIMIT 1" },
  { what: "events.payment_provider",     file: "0003_payhero_repair.sql", sql: "SELECT payment_provider FROM events LIMIT 1" }
];
async function paymentSchemaState(env){
  const out = { ready: true, missing: [], migrations: [], hint: "" };
  if(!env || !env.DB){
    out.ready = false;
    out.missing.push("database_binding");
    return out;
  }
  for(const check of PAYMENT_SCHEMA_CHECKS){
    try { await env.DB.prepare(check.sql).bind().all(); }
    catch(e){
      out.ready = false;
      out.missing.push(check.what);
      if(out.migrations.indexOf(check.file) < 0) out.migrations.push(check.file);
    }
  }
  if(!out.ready){
    out.hint = "wrangler d1 execute <database> --remote --file=worker/migrations/" + out.migrations[0];
    /* The provider table exists but a payments column does not: the migration
       stopped partway. Repairing that is not the same command as migrating a
       database that was never touched, so say so. */
    out.partially_applied = out.missing.indexOf("organizer_payment_providers") < 0;
    if(out.partially_applied){
      out.hint = "wrangler d1 execute <database> --remote --file=worker/migrations/0003_payhero_repair.sql";
      out.note = "The provider table exists but the payments table is behind: 0002 stopped partway. 0003_payhero_repair.sql adds only what is missing, one statement at a time, so a column that is already there cannot hold up the rest. If the provider CHECK constraints are still older than 'payhero', follow it with 0004_payhero_check_rebuild.sql, which rebuilds payments and payment_settings from a copy of every row.";
    }
  }
  return out;
}
/* Is the database migrated for free-ticket verification (migration 0006)? Same
   shape as paymentSchemaState so GET /api/health answers both the same way. */
async function freeTicketSchemaState(env){
  const out = { ready: true, missing: [], migrations: [], hint: "" };
  if(!env || !env.DB){
    out.ready = false;
    out.missing.push("database_binding");
    return out;
  }
  const checks = [
    { what: "free_ticket_sessions",     sql: "SELECT COUNT(*) AS n FROM free_ticket_sessions" },
    { what: "free_ticket_claims",       sql: "SELECT COUNT(*) AS n FROM free_ticket_claims" },
    { what: "events.free_otp_enabled",  sql: "SELECT free_otp_enabled FROM events LIMIT 1" },
    { what: "events.free_ticket_limit", sql: "SELECT free_ticket_limit FROM events LIMIT 1" },
    { what: "events.ip_abuse_enabled",  sql: "SELECT ip_abuse_enabled FROM events LIMIT 1" }
  ];
  for(const check of checks){
    try { await env.DB.prepare(check.sql).bind().all(); }
    catch(e){ out.ready = false; out.missing.push(check.what); }
  }
  if(!out.ready){
    out.migrations.push("0006_free_ticket_otp.sql");
    out.hint = "wrangler d1 execute <database> --remote --file=worker/migrations/0006_free_ticket_otp.sql";
  }
  /* True when a keyed secret exists for OTP / identity hashing. Without one the
     free-ticket routes refuse rather than storing anything weaker. */
  out.otp_key_configured = freeOtpKeyReady(env);
  return out;
}
async function routeHealth(ctx){

  return json({
    success: true,
    service: API_NAME,
    status: "ok",
    time: new Date().toISOString(),
    /* Which rate-limit tier is actually enforcing: a native Cloudflare binding
       if one is bound, otherwise the D1 counter, otherwise per-isolate memory
       (which is a safety net, not a global limit). "degraded" means the D1
       table is missing or unreachable - run the migration. */
    rate_limit_store: rateStoreState,
    rate_limit_actions: Object.keys(RATE_POLICIES).length,
    /* False means the PayHero migration has not been applied yet: checkout
       answers with an actionable 500 until it has. */
    payment_schema: await paymentSchemaState(ctx.env),
    /* Free-ticket verification (migration 0006): ready=false names the file to
       run, and otp_key_configured=false means no FREE_TICKET_OTP_KEY is set. */
    free_ticket_schema: await freeTicketSchemaState(ctx.env)
  }, 200, corsFor(ctx.env, ctx.request));
}
async function routeCategories(ctx){
  const rows = await dbAll(ctx.env,
    "SELECT category, COUNT(*) AS total FROM events WHERE status = 'active' AND category IS NOT NULL AND category != '' GROUP BY category ORDER BY category ASC");
  const counts = {};
  for(const r of rows) counts[r.category] = Number(r.total);
  return ok({
    categories: CATEGORIES.map(name => ({ name: name, slug: name.toLowerCase(), count: counts[name] || 0 })),
    data: CATEGORIES
  }, corsFor(ctx.env, ctx.request));
}
function eventSelectSql(){
  return "SELECT e.*, o.business_name AS organizer_name, o.logo_url AS organizer_logo, o.status AS organizer_status, " +
    "(SELECT MIN(tt.price) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'active') AS starting_price, " +
    "(SELECT SUM(MAX(0, tt.quantity - tt.sold)) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'active') AS available_total " +
    "FROM events e LEFT JOIN organizers o ON o.id = e.organizer_id";
}
/* Adds the derived fields the event cards need. */
function cardEvent(ev){
  const price = (ev.starting_price === null || ev.starting_price === undefined) ? null : Number(ev.starting_price);
  return Object.assign(publicEvent(ev), {
    organizer_name: ev.organizer_name || null,
    starting_price: price,
    is_free: price === 0,
    available_total: ev.available_total == null ? null : Number(ev.available_total)
  });
}
function addDays(isoDate, days){
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/* GET /api/events - public discovery. Only ever reads published statuses. */
async function routePublicEvents(ctx){
  const env = ctx.env, url = ctx.url;
  const q = url.searchParams;
  const where = [], params = [];
  const statusParam = String(q.get("status") || "public").toLowerCase();
  if(statusParam === "active") where.push("e.status = 'active'");
  else if(EVENT_STATUSES.indexOf(statusParam) > -1){ where.push("e.status = ?"); params.push(statusParam); }
  else where.push("e.status IN ('active','sold_out')");

  if(q.get("featured") === "true" || q.get("featured") === "1") where.push("e.is_featured = 1");

  const search = vStr(q.get("q"), "search", { max: 80 });
  if(search){
    where.push("(e.title LIKE ? OR e.venue LIKE ? OR e.location LIKE ? OR e.category LIKE ? OR e.description LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like, like);
  }
  const category = vStr(q.get("category"), "category", { max: 40 });
  if(category && category.toLowerCase() !== "all"){ where.push("e.category = ?"); params.push(category); }
  const location = vStr(q.get("location"), "location", { max: 60 });
  if(location){ where.push("(e.location LIKE ? OR e.venue LIKE ?)"); params.push("%" + location + "%", "%" + location + "%"); }

  /* Discovery filters are Kenyan calendar days (see keToday). */
  const today = keToday();
  const dateFilter = vStr(q.get("date") || q.get("when"), "date", { max: 20 });
  if(dateFilter === "today"){ where.push("e.event_date = ?"); params.push(today); }
  else if(dateFilter === "week"){ where.push("e.event_date >= ? AND e.event_date <= ?"); params.push(today, addDays(today, 7)); }
  else if(dateFilter === "month"){ where.push("e.event_date >= ? AND e.event_date <= ?"); params.push(today, addDays(today, 30)); }
  else if(/^\d{4}-\d{2}-\d{2}$/.test(dateFilter)){ where.push("e.event_date = ?"); params.push(dateFilter); }
  else if(dateFilter === "past"){ where.push("e.event_date < ?"); params.push(today); }
  else { where.push("(e.event_date IS NULL OR e.event_date >= ?)"); params.push(today); }

  const maxPrice = q.get("max_price");
  if(maxPrice != null && maxPrice !== ""){
    const cap = vInt(maxPrice, "maximum price", { min: 0, label: "Maximum price" });
    where.push("(SELECT MIN(tt.price) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'active') <= ?");
    params.push(cap);
  }

  const sorts = {
    soonest: "e.event_date ASC, e.start_time ASC",
    latest: "e.event_date DESC",
    newest: "e.created_at DESC",
    price_low: "starting_price ASC",
    price_high: "starting_price DESC"
  };
  const sortKey = String(q.get("sort") || "soonest").toLowerCase();
  const orderBy = sorts[sortKey] || sorts.soonest;

  const whereSql = where.length ? (" WHERE " + where.join(" AND ")) : "";
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM events e" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env,
    eventSelectSql() + whereSql + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?",
    params.concat([p.limit, p.offset]));
  return ok({
    events: rows.map(cardEvent),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, corsFor(env, ctx.request));
}
/* GET /api/events/:slug - accepts the slug or the numeric id. */
async function routePublicEvent(ctx){
  const env = ctx.env;
  const key = vStr(ctx.params.slug, "event", { required: true, max: 80 });
  const ev = /^\d+$/.test(key)
    ? await dbGet(env, eventSelectSql() + " WHERE e.id = ?", [Number(key)])
    : await dbGet(env, eventSelectSql() + " WHERE e.slug = ?", [key]);
  if(!ev) throw err(404, "We could not find that event.", "NOT_FOUND");
  if(["active", "sold_out", "ended", "cancelled"].indexOf(String(ev.status)) < 0){
    throw err(404, "We could not find that event.", "NOT_FOUND");
  }
  const tickets = await dbAll(env, "SELECT * FROM ticket_types WHERE event_id = ? AND status = 'active' ORDER BY price ASC, id ASC", [ev.id]);
  const payload = cardEvent(ev);
  payload.tickets = tickets.map(publicTicketType);
  payload.organizer = { name: ev.organizer_name || null, logo_url: ev.organizer_logo || null };
  return ok({ event: payload, tickets: payload.tickets }, corsFor(env, ctx.request));
}
/* GET /api/events/:id/tickets - public availability view. */
async function routePublicEventTickets(ctx){
  const env = ctx.env;
  const key = vStr(ctx.params.id, "event", { required: true, max: 80 });
  const ev = /^\d+$/.test(key)
    ? await dbGet(env, "SELECT * FROM events WHERE id = ?", [Number(key)])
    : await dbGet(env, "SELECT * FROM events WHERE slug = ?", [key]);
  if(!ev) throw err(404, "We could not find that event.", "NOT_FOUND");
  const rows = await dbAll(env, "SELECT * FROM ticket_types WHERE event_id = ? AND status = 'active' ORDER BY price ASC, id ASC", [ev.id]);
  return ok({ tickets: rows.map(publicTicketType), event_id: ev.id, event_status: ev.status }, corsFor(env, ctx.request));
}
/* ------------------------------------- GET /api/tickets/:ticketNumber ------
   Public: the holder needs to open their own ticket. Only paid orders expose a
   QR image, and the QR contains the opaque token only. */
async function routeTicketByNumber(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "ticket_lookup", {});
  const number = vStr(ctx.params.ticketNumber, "ticket number", { required: true, max: 40 });
  const t = await dbGet(env, TICKET_SELECT + " WHERE t.ticket_number = ?", [number]);
  if(!t) throw err(404, "We could not find that ticket. Check the ticket number and try again.", "NOT_FOUND");
  const paid = String(t.order_status) === "paid";
  const payload = ticketPayload(t, {
    order_status: t.order_status,
    valid_for_entry: paid && String(t.status) === "valid",
    qr_image_url: paid ? qrUrlFor(request, t.ticket_number) : null
  });
  return ok({ ticket: payload, event: { title: t.event_title, event_date: t.event_date, start_time: t.start_time, venue: t.venue, location: t.location, poster_url: t.poster_url } },
    corsFor(env, request));
}
/* --------------------------- GET /api/tickets/:ticketNumber/qr.png --------
   Renders a real PNG QR code for a PAID ticket. Unpaid tickets never get one. */
async function routeTicketQr(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "ticket_qr", {});
  const number = vStr(ctx.params.ticketNumber, "ticket number", { required: true, max: 40 });
  const t = await dbGet(env, TICKET_SELECT + " WHERE t.ticket_number = ?", [number]);
  if(!t || String(t.order_status) !== "paid") throw err(404, "That QR code is not available.", "NOT_FOUND");
  const png = qrPngBytes(t.qr_token);
  return imageResponse(png, "image/png", {
    "Content-Disposition": "inline; filename=\"" + t.ticket_number + ".png\"",
    "Cache-Control": "private, max-age=600"
  });
}
/* ---------------------------------------------- GET /media/:key ------------
   Poster/logo delivery. The key must match the pattern the Worker itself
   generates, so the route cannot be used to walk the bucket. */
async function routeMedia(ctx){
  const env = ctx.env, request = ctx.request;
  const raw = String(ctx.params.key || "");
  let key = raw;
  try { key = decodeURIComponent(raw); } catch(e){ key = raw; }
  if(!MEDIA_KEY_RE.test(key)) throw err(404, "Not found.", "NOT_FOUND");
  const obj = await env.BUCKET.get(key);
  if(!obj) throw err(404, "Not found.", "NOT_FOUND");
  const ext = key.split(".").pop().toLowerCase();
  const type = ext === "png" ? "image/png" : (ext === "webp" ? "image/webp" : "image/jpeg");
  const headers = new Headers();
  headers.set("Content-Type", (obj.httpMetadata && obj.httpMetadata.contentType) || type);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  if(obj.httpEtag) headers.set("ETag", obj.httpEtag);
  if(request.headers.get("If-None-Match") === obj.httpEtag){
    return new Response(null, { status: 304, headers: headers });
  }
  return new Response(obj.body, { status: 200, headers: headers });
}
/* ------------------------------------------------- POST /api/contact ------ */
async function routeContact(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  /* Per-IP AND per-address limits, counted before the challenge: a spammer can
     neither flood the Worker nor spray one inbox from many addresses/IPs. */
  await guardRate(env, request, "contact", { email: body.email });
  await requireTurnstile(env, request, body, "contact");
  const name = vStr(body.name || body.full_name, "name", { required: true, min: 2, max: 120, label: "Your name" });
  const email = vEmail(body.email, "email", true);
  const subject = vStr(body.subject, "subject", { max: 160 });
  const message = vStr(body.message, "message", { required: true, min: 10, max: 4000, label: "Message" });
  await dbRun(env, "INSERT INTO contact_messages (name, email, subject, message) VALUES (?,?,?,?)", [name, email, subject || null, message]);
  /* D1 is the record of truth; the notification emails are a convenience on top. */
  const delivered = await sendContactEmails(env, {
    name: name, email: email, phone: vStr(body.phone, "phone", { max: 32 }) || "",
    subject: subject || "", body: message, sent_at: touch()
  }, request, ctx.ctx);
  return created({
    message: "Thank you. Your message has been received and our team will respond shortly.",
    emailed_to_support: !!delivered.support,
    owner_notified: !!delivered.owner_notified,
    acknowledgement_sent: !!delivered.acknowledgement
  }, corsFor(env, request));
}

/* ============================================================================
   PAYMENT WEBHOOKS / IPN - ONE unified callback processing layer
   ----------------------------------------------------------------------------
   Publicly reachable, but never authoritative on their own. Every provider
   callback runs the same seven steps, in this order:

     1. identify the provider (the route it arrived on - never the payload)
     2. verify authenticity with THAT provider's own scheme
          Paystack  HMAC-SHA512 signature over the raw request body
          Pesapal   unsigned IPN, so a follow-up GetTransactionStatus is mandatory
          PayHero   Basic Authorization header when present, plus a mandatory
                    follow-up GetTransactionStatus; a callback alone can NEVER
                    mark an order paid
     3. locate the internal transaction by the reference THIS server issued
     4. the notification reference must match what we issued
     5. the notified amount must equal the stored order total
     6. re-verify with the provider and update the transaction
     7. mark the order PAID and issue tickets only after a verified success

   The sequence is idempotent: a replay finds the order already paid and returns
   without writing anything, so a callback can never double-issue a ticket, and
   payments.reference is UNIQUE, so there is one internal transaction per order.
   ========================================================================== */
async function processProviderCallback(ctx){
  const env = ctx.env, request = ctx.request;
  const providerKey = ctx.provider_key;
  const cors = corsFor(env, request);
  const locate = ctx.locate || {};
  if(!locate.reference && !locate.provider_ref){
    return ok({ received: true, ignored: "no_identifiers" }, cors);
  }
  /* 3. locate: by our own reference, else by the provider reference we stored
     when we started the payment. Never by anything the payload invents. */
  const payment = locate.reference
    ? await dbGet(env, "SELECT * FROM payments WHERE reference = ?", [locate.reference])
    : await dbGet(env, "SELECT * FROM payments WHERE provider_ref = ?", [locate.provider_ref]);
  if(!payment || String(payment.provider) !== providerKey){
    return ok({ received: true, ignored: "unknown_reference" }, cors);
  }
  const order = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [payment.order_id]);
  if(!order) return ok({ received: true, ignored: "unknown_order" }, cors);
  /* 4. the reference in the notification must be the one we issued. */
  if(locate.reference && !safeEqual(String(payment.reference), String(locate.reference))){
    return ok({ received: true, ignored: "reference_mismatch" }, cors);
  }
  /* 2. authenticity, provider specific, BEFORE anything is written. Only the
     reference has been read from the unverified request so far, and reading it
     changes nothing on its own. The credentials used here always belong to the
     provider THIS transaction belongs to, whatever the active provider is now. */
  const settings = await loadPaymentSettings(env, order.organizer_id);
  /* Same rule as the settlement above: verify with the credentials of the
     transaction's own provider. allowPlatform keeps pre-strict orders (billed
     to the shared account) verifiable; new orders always carry own keys. */
  const creds = await resolveCredentials(env, settings, providerKey, { organizer_id: order.organizer_id, allowPlatform: true });
  if(!creds) return ok({ received: true, ignored: "no_credentials" }, cors);
  const auth = await PaymentService.verifyWebhook({
    provider_key: providerKey, creds: creds, raw_body: ctx.raw_body || "",
    signature: ctx.signature || null, authorization: ctx.authorization || null
  });
  if(auth.rejected) throw err(401, "Invalid webhook signature.", "BAD_SIGNATURE");
  /* 5. amount manipulation: a notification claiming a different amount than the
     stored order total is refused, and the reason is recorded for the organizer.
     Recording that reason is only safe now, because the request is authenticated. */
  const expected = Number(order.total_amount);
  if(locate.amount != null && Number.isFinite(Number(locate.amount)) && Math.round(Number(locate.amount)) !== expected){
    await dbRun(env, "UPDATE payments SET failure_reason = 'amount_mismatch', failure_at = COALESCE(failure_at, ?), updated_at = ? WHERE id = ? AND status != 'success'",
      [touch(), touch(), payment.id]);
    return ok({ received: true, settled: false, mismatch: "amount" }, cors);
  }
  /* Duplicate / replay: the order is already settled, so acknowledge and stop.
     No second verification call, no second ticket, no second email. */
  if(order.status === "paid"){
    return ok({ received: true, settled: true, duplicate: true, first_time: false, tickets_issued: 0 }, cors);
  }
  const providerRef = locate.provider_ref || payment.provider_ref;
  if(!providerRef) return ok({ received: true, ignored: "no_provider_ref" }, cors);
  /* 6 + 7. the provider decides the outcome; the callback only asked us to look. */
  const settled = await PaymentService.settle({
    env: env, order: order, payment: payment, provider_key: providerKey, creds: creds,
    provider_ref: providerRef, request: request, task: ctx.ctx,
    hints: { callback_amount: (locate.amount != null) ? locate.amount : null }
  });
  return ok({
    received: true,
    settled: settled.settled === true,
    first_time: settled.first_time === true,
    mismatch: settled.mismatch || null,
    tickets_issued: settled.tickets ? settled.tickets.created : 0
  }, cors);
}
/* ------------------------------------------------- POST /api/webhooks/paystack
   Paystack adapter: HMAC-SHA512 over the raw body, in the x-paystack-signature
   header. The amount arrives in subunits and is divided here, at the edge. */
async function routePaystackWebhook(ctx){
  const env = ctx.env, request = ctx.request;
  const raw = await request.text();
  let event = null;
  try { event = raw ? JSON.parse(raw) : null; } catch(e){ event = null; }
  if(!event || !event.data || !event.data.reference){
    return ok({ received: true, ignored: "malformed_payload" }, corsFor(env, request));
  }
  if(String(event.event || "") !== "charge.success"){
    return ok({ received: true, ignored: String(event.event || "unknown_event") }, corsFor(env, request));
  }
  return processProviderCallback({
    env: env, request: request, ctx: ctx, provider_key: "paystack", raw_body: raw,
    signature: request.headers.get("x-paystack-signature"),
    authorization: request.headers.get("authorization"),
    locate: { reference: String(event.data.reference),
      amount: (event.data.amount != null) ? Math.round(Number(event.data.amount) / 100) : null }
  });
}
/* ------------------------------------------------ GET|POST /api/webhooks/pesapal
   Pesapal IPN adapter. The notification itself carries no signature, so the
   unified processor always follows it with GetTransactionStatus. */
async function routePesapalWebhook(ctx){
  const env = ctx.env, request = ctx.request;
  let raw = "", data = {};
  let trackingId = "", merchantRef = "";
  if(request.method === "GET"){
    trackingId = ctx.url.searchParams.get("OrderTrackingId") || ctx.url.searchParams.get("orderTrackingId") || "";
    merchantRef = ctx.url.searchParams.get("OrderMerchantReference") || ctx.url.searchParams.get("orderMerchantReference") || "";
  } else {
    raw = await request.text();
    const ctype = String(request.headers.get("content-type") || "");
    if(ctype.indexOf("application/json") > -1){
      try { data = JSON.parse(raw || "{}") || {}; } catch(e){ data = {}; }
    } else {
      const form = new URLSearchParams(raw || "");
      for(const pair of form) data[pair[0]] = pair[1];
    }
    trackingId = data.OrderTrackingId || data.orderTrackingId || data.order_tracking_id || "";
    merchantRef = data.OrderMerchantReference || data.orderMerchantReference || data.merchant_reference || "";
  }
  /* The merchant reference is what we issued, so it is the safe lookup key. */
  const located = merchantRef
    ? { reference: String(merchantRef), provider_ref: String(trackingId || "") }
    : { reference: "", provider_ref: String(trackingId || "") };
  if(!located.reference && !located.provider_ref){
    return ok({ received: true, ignored: "no_identifiers" }, corsFor(env, request));
  }
  try {
    return await processProviderCallback({
      env: env, request: request, ctx: ctx, provider_key: "pesapal", raw_body: raw,
      signature: null, authorization: request.headers.get("authorization"),
      locate: located
    });
  } catch(e){
    console.error("PESAPAL_IPN_ERROR", (e && e.message) || String(e));
    return ok({ received: true, verified: false }, corsFor(env, request));
  }
}
/* ------------------------------------------------- POST /api/webhooks/payhero
   PayHero adapter. The documented callback body is
     { forward_url, status, response: { Amount, CheckoutRequestID,
       ExternalReference, MerchantRequestID, MpesaReceiptNumber, Phone,
       ResultCode, ResultDesc, Status } }
   ExternalReference is the order number we sent, so the transaction is found by
   our own reference and the outcome is decided by PayHero's own status call. */
async function routePayheroWebhook(ctx){
  const env = ctx.env, request = ctx.request;
  const raw = await request.text();
  const parsed = PayheroProvider.readWebhookEvent(raw);
  if(!parsed){
    return ok({ received: true, ignored: "malformed_payload" }, corsFor(env, request));
  }
  if(!parsed.reference){
    /* No ExternalReference: nothing can be located from this callback. */
    return ok({ received: true, ignored: "no_identifiers" }, corsFor(env, request));
  }
  return processProviderCallback({
    env: env, request: request, ctx: ctx, provider_key: "payhero", raw_body: raw,
    signature: null, authorization: request.headers.get("authorization"),
    /* provider_ref is left empty on purpose: PayHero's transaction-status is
       keyed by the PayHero reference stored at checkout, not by CheckoutRequestID. */
    locate: { reference: parsed.reference, provider_ref: "", amount: parsed.amount }
  });
}

/* ============================================================================
   QR CHECK-IN
   ----------------------------------------------------------------------------
   The scanner is never trusted: every field in the answer is derived from D1
   after the caller's identity and event permission have been checked.
   ========================================================================== */
async function routeCheckIn(ctx){
  const env = ctx.env, request = ctx.request;
  const auth = await requireAuth(env, request);
  const body = await readJson(request);
  /* Counted per staff user (per minute AND per hour) plus per IP: a venue behind
     one NAT address is never locked out, while a stolen session cannot walk the
     whole ticket table. Deliberately generous - a gate scans many different
     tickets in a row. */
  await guardRate(env, request, "checkin", {
    uid: (auth.ident && auth.ident.uid) || (auth.user && auth.user.firebase_uid) || ""
  });
  const eventId = vInt(body.event_id, "event", { min: 1, label: "Event" });
  const code = vStr(body.code || body.qr_token || body.ticket_number || body.ticket, "code",
    { required: true, max: 64, label: "Ticket code" });
  const ev = await eventAccess(env, auth.user, eventId, false);
  const t = await dbGet(env, TICKET_SELECT + " WHERE (t.qr_token = ? OR t.ticket_number = ?) AND t.event_id = ?",
    [code, code, ev.id]);
  const cors = corsFor(env, request);
  if(!t){
    return ok({ valid: false, status: "invalid", result: {
      valid: false, status: "invalid", already_checked_in: false,
      message: "This ticket was not found for " + ev.title + "."
    } }, cors);
  }
  const base = {
    ticket_number: t.ticket_number,
    number: t.ticket_number,
    attendee_name: t.attendee_name,
    attendee: t.attendee_name,
    ticket_type_name: t.ticket_type_name || "Ticket",
    ticket_type: t.ticket_type_name || "Ticket",
    event_id: ev.id,
    event_title: ev.title
  };
  if(String(t.order_status) !== "paid"){
    return ok({ valid: false, status: "unpaid", result: Object.assign({}, base, {
      valid: false, status: "invalid", already_checked_in: false,
      message: "This ticket has not been paid for, so it is not valid for entry."
    }) }, cors);
  }
  if(String(t.status) === "void"){
    return ok({ valid: false, status: "void", result: Object.assign({}, base, {
      valid: false, status: "invalid", already_checked_in: false,
      message: "This ticket has been cancelled by the organizer."
    }) }, cors);
  }
  if(Number(t.checked_in) === 1){
    return ok({ valid: false, status: "already_checked_in", result: Object.assign({}, base, {
      valid: false, status: "already_checked_in", already_checked_in: true,
      checked_in_at: t.checked_in_at,
      message: "This ticket was already used at " + (t.checked_in_at || "an earlier time") + "."
    }) }, cors);
  }
  if(body.mode === "lookup"){
    return ok({ valid: true, status: "valid", result: Object.assign({}, base, {
      valid: true, status: "valid", already_checked_in: false,
      message: "Valid ticket. Review the attendee details before checking them in."
    }) }, cors);
  }
  /* Conditional update: two scanners racing the same ticket cannot both win. */
  const stamp = touch();
  const upd = await dbRun(env,
    "UPDATE tickets SET checked_in = 1, checked_in_at = ?, checked_in_by = ?, status = 'used' WHERE id = ? AND checked_in = 0",
    [stamp, auth.user.id, t.id]);
  if(!(upd && upd.meta && upd.meta.changes === 1)){
    const fresh = await dbGet(env, "SELECT checked_in_at FROM tickets WHERE id = ?", [t.id]);
    return ok({ valid: false, status: "already_checked_in", result: Object.assign({}, base, {
      valid: false, status: "already_checked_in", already_checked_in: true,
      checked_in_at: fresh ? fresh.checked_in_at : null,
      message: "This ticket has just been checked in by another device."
    }) }, cors);
  }
  return ok({ valid: true, status: "valid", result: Object.assign({}, base, {
    valid: true, status: "valid", already_checked_in: false, checked_in_at: stamp,
    message: "Valid ticket. You may admit this attendee."
  }) }, cors);
}

/* ============================================================================
   ORGANIZER API
   ========================================================================== */
/* GET /api/me - who the signed-in Firebase user is according to D1. */
async function routeMe(ctx){
  const env = ctx.env, request = ctx.request;
  const { user } = await requireAuth(env, request);
  const org = await dbGet(env, "SELECT * FROM organizers WHERE user_id = ?", [user.id]);
  const base = mePayload(user, org);
  const assigned = user.role === "event_staff"
    ? (await dbAll(env, "SELECT event_id FROM event_staff WHERE user_id = ?", [user.id])).map(r => Number(r.event_id))
    : [];
  return ok(Object.assign({}, base, {
    role: user.role,
    user: Object.assign({}, base.user, { role: user.role }),
    assigned_event_ids: assigned,
    is_owner: user.role === "owner",
    has_organizer_profile: !!org
  }), corsFor(env, request));
}
/* ------------------------------------------- POST /api/auth/turnstile ------
   Firebase Authentication signs users in and sends password-reset links from
   the browser, so those calls cannot hand a Turnstile token to Firebase itself
   (Firebase email/password sign-in accepts no third-party challenge). The
   login and forgot-password pages therefore verify the challenge
   HERE first - server side, rate limited, with the action the widget was
   rendered with - and only continue to the Firebase call once the Worker
   answers verified:true. Nothing is stored: the token is single use, it is
   never echoed back, and the response is a stateless acknowledgement rather
   than an authentication credential. */
const TURNSTILE_ACTION_POLICY = { "login": "login", "password-reset": "password_reset", "email-verification": "otp" };
async function routeAuthTurnstile(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  const action = vEnum(body.action, TURNSTILE_CLIENT_ACTIONS, "action");
  /* Firebase signs users in and sends reset links from the browser, so this
     endpoint is where those attempts are throttled:
       login            5 / 15 min per IP  + 10 / 15 min per account
       password-reset   3 / hour   per email +  5 / hour   per IP
       email-verification (OTP)  3 / hour per email + 5 / hour per IP
     The limits run BEFORE the challenge, so a flood costs no Siteverify call and
     a challenge success is never treated as a rate-limit exemption. */
  await guardRate(env, request, TURNSTILE_ACTION_POLICY[action] || "turnstile_auth", { email: body.email });
  const result = await requireTurnstile(env, request, body, action);
  return ok({
    verified: true,
    action: action,
    enforced: !result.skipped,
    expires_in: Math.round(TURNSTILE_TTL_MS / 1000)
  }, corsFor(env, request));
}
/* POST /api/auth/register - Firebase already created the login; this creates
   the application profile in D1. Any client-supplied role is ignored: only a
   plain organizer can ever be self-registered here. */
async function routeRegister(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  /* 5 registrations per hour per IP, counted before the challenge and before the
     Firebase token is verified. */
  await guardRate(env, request, "register", { email: body.email });
  /* The challenge is checked before Firebase verification and before any D1
     write, so an unauthenticated bot cannot make this Worker do key lookups. */
  await requireTurnstile(env, request, body, "register");
  const { user } = await requireAuth(env, request);
  const fullName = vStr(body.full_name || body.name, "full name", { required: true, min: 3, max: 120, label: "Full name" });
  const email = vEmail(body.email || user.email, "email", true);
  const phone = vPhone(body.phone, "phone", true);
  const businessName = vStr(body.business_name, "business name", { max: 160, label: "Business name" });
  const businessEmail = vEmail(body.business_email, "business email", false);
  const businessPhone = vPhone(body.business_phone, "business phone", false);
  await dbRun(env, "UPDATE users SET full_name = ?, phone = ?, updated_at = ? WHERE id = ?",
    [fullName, phone, touch(), user.id]);
  let org = await dbGet(env, "SELECT * FROM organizers WHERE user_id = ?", [user.id]);
  let newOrganizer = false;
  if(!org){
    await dbRun(env, "INSERT INTO organizers (user_id, business_name, business_email, business_phone, logo_url, status) VALUES (?,?,?,?,NULL,'active')",
      [user.id, businessName || fullName, businessEmail || email, businessPhone || phone]);
    org = await dbGet(env, "SELECT * FROM organizers WHERE user_id = ?", [user.id]);
    newOrganizer = true;
  } else if(businessName || businessEmail || businessPhone){
    await dbRun(env, "UPDATE organizers SET business_name = ?, business_email = ?, business_phone = ?, updated_at = ? WHERE id = ?",
      [businessName || org.business_name, businessEmail || org.business_email, businessPhone || org.business_phone, touch(), org.id]);
    org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [org.id]);
  }
  const updated = await dbGet(env, "SELECT * FROM users WHERE id = ?", [user.id]);
  /* Onboarding email, once per account (the dedupe key makes it idempotent). */
  if(newOrganizer) await sendWelcomeEmail(env, updated, org, request, ctx.ctx);
  const payload = mePayload(updated, org);
  return created(Object.assign({}, payload, { role: updated.role, message: "Your organizer account is ready." }),
    corsFor(env, request));
}
/* GET /api/organizer/dashboard */
async function routeOrganizerDashboard(ctx){
  const env = ctx.env, request = ctx.request;
  const { user, org } = await requireOrganizer(env, request);
  const cors = corsFor(env, request);
  const eventsCount = await dbGet(env, "SELECT COUNT(*) AS n FROM events WHERE organizer_id = ?", [org.id]);
  const activeCount = await dbGet(env, "SELECT COUNT(*) AS n FROM events WHERE organizer_id = ? AND status = 'active'", [org.id]);
  const sold = await dbGet(env,
    "SELECT COALESCE(SUM(oi.quantity),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.organizer_id = ? AND o.status = 'paid'", [org.id]);
  const revenue = await dbGet(env, "SELECT COALESCE(SUM(total_amount),0) AS n FROM orders WHERE organizer_id = ? AND status = 'paid'", [org.id]);
  const pending = await dbGet(env, "SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS amount FROM orders WHERE organizer_id = ? AND status = 'pending'", [org.id]);
  const checked = await dbGet(env,
    "SELECT COUNT(*) AS n FROM tickets t JOIN events e ON e.id = t.event_id WHERE e.organizer_id = ? AND t.checked_in = 1", [org.id]);
  const issued = await dbGet(env,
    "SELECT COUNT(*) AS n FROM tickets t JOIN events e ON e.id = t.event_id WHERE e.organizer_id = ?", [org.id]);
  const recent = await dbAll(env,
    "SELECT e.*, (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.event_id = e.id AND o.status = 'paid') AS tickets_sold, " +
    "(SELECT COALESCE(SUM(o.total_amount),0) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid') AS revenue " +
    "FROM events e WHERE e.organizer_id = ? ORDER BY e.created_at DESC LIMIT 8", [org.id]);
  const settings = await loadPaymentSettings(env, org.id);
  const providerKey = providerKeyOf(settings);
  const providerRows = await loadProviderRows(env, org.id);
  const providerStateForActive = await providerState(env, settings, providerKey, providerRows[providerKey] || null);
  const creds = providerStateForActive.configured ? { source: providerStateForActive.credentials_source } : null;
  /* Money split for THIS organizer: what landed in the owner's account vs their
     own, from the frozen checkout snapshot (absent before migration 0007). */
  let money = null;
  try {
    const mtCols = await moneyTrailCols(env);
    if(mtCols.collected_via){
      const m = await dbGet(env,
        "SELECT COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN total_amount ELSE 0 END),0) AS owner_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN 1 ELSE 0 END),0) AS owner_count, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN total_amount ELSE 0 END),0) AS organizer_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN 1 ELSE 0 END),0) AS organizer_count FROM orders WHERE organizer_id = ?", [org.id]);
      money = { owner_amount: Number((m && m.owner_amount) || 0), owner_count: Number((m && m.owner_count) || 0),
        organizer_amount: Number((m && m.organizer_amount) || 0), organizer_count: Number((m && m.organizer_count) || 0) };
    }
  } catch(e){ money = null; }
  const gross = revenue ? Number(revenue.n) : 0;
  const stats = {
    total_events: eventsCount ? Number(eventsCount.n) : 0,
    active_events: activeCount ? Number(activeCount.n) : 0,
    tickets_sold: sold ? Number(sold.n) : 0,
    tickets_issued: issued ? Number(issued.n) : 0,
    checked_in: checked ? Number(checked.n) : 0,
    gross_revenue: gross,
    revenue: gross,
    pending_orders: pending ? Number(pending.n) : 0,
    pending_amount: pending ? Number(pending.amount) : 0,
    owner_collected_amount: money ? money.owner_amount : 0,
    owner_collected_count: money ? money.owner_count : 0,
    organizer_collected_amount: money ? money.organizer_amount : 0,
    organizer_collected_count: money ? money.organizer_count : 0,
    money_split: money,
    payment_provider: providerKey,
    payment_provider_label: providerLabel(providerKey),
    payment_connected: !!creds,
    payment_provider_status: providerStateForActive.status,
    /* Which of the three this organizer actually has usable today. */
    payment_providers_connected: PAYMENT_PROVIDER_KEYS.filter(k => {
      const row = providerRows[k] || null;
      return row ? (Number(row.enabled) !== 0 && rowConfigured(k, row)) : false;
    })
  };
  return ok({
    stats: stats,
    summary: stats,
    organizer: mePayload(user, org).organizer,
    recent_events: recent.map(ev => Object.assign(cardEvent(ev), {
      tickets_sold: Number(ev.tickets_sold || 0),
      revenue: Number(ev.revenue || 0)
    }))
  }, cors);
}
/* An event may only name a provider the organizer has actually connected with
   their OWN keys, so a broken override can never be stored and never silently
   become a fallback. Owner payment mode is chosen separately via payment_mode,
   so it is NOT accepted here - the organizer must still connect (or explicitly
   use owner mode for) the event. */
async function checkEventProviderChoice(env, organizerId, requested){
  if(!requested) return null;
  const settings = await loadPaymentSettings(env, organizerId);
  const row = await loadProviderRow(env, organizerId, requested);
  const state = await providerState(env, settings, requested, row);
  if(state.configured && state.enabled && state.status !== "error") return requested;
  throw err(422, "You cannot use " + providerLabel(requested) + " for this event because it is not connected on your account. Connect it in Payment Settings first, or set this event to owner payment mode.", "PROVIDER_NOT_CONFIGURED");
}
function organizerEventPayload(ev){
  let freeConfig = null;
  try { freeConfig = ev.free_ticket_config ? JSON.parse(ev.free_ticket_config) : null; } catch(e){ freeConfig = null; }
  return Object.assign({}, ev, {
    is_featured: !!ev.is_featured,
    starting_price: ev.starting_price == null ? null : Number(ev.starting_price),
    available_total: ev.available_total == null ? null : Number(ev.available_total),
    tickets_sold: ev.tickets_sold == null ? undefined : Number(ev.tickets_sold),
    revenue: ev.revenue == null ? undefined : Number(ev.revenue),
    payment_provider: ev.payment_provider || null,
    payment_provider_label: ev.payment_provider ? providerLabel(ev.payment_provider) : null,
    payment_mode: ev.payment_mode || null,
    /* Free-ticket verification settings, as the organizer dashboard consumes them. */
    free_otp_enabled: ev.free_otp_enabled === undefined || ev.free_otp_enabled === null ? true : Number(ev.free_otp_enabled) === 1,
    ip_abuse_enabled: ev.ip_abuse_enabled === undefined || ev.ip_abuse_enabled === null ? true : Number(ev.ip_abuse_enabled) === 1,
    free_ticket_limit: ev.free_ticket_limit == null ? 1 : Number(ev.free_ticket_limit),
    free_ticket_config: freeConfig
  });
}
async function uniqueSlug(env, title, ignoreId){
  for(let attempt = 0; attempt < 8; attempt++){
    const candidate = slugify(title, attempt === 0 ? null : randomCode(4).toLowerCase());
    const clash = await dbGet(env, "SELECT id FROM events WHERE slug = ?", [candidate]);
    if(!clash || (ignoreId && Number(clash.id) === Number(ignoreId))) return candidate;
  }
  return slugify(title, randomCode(8).toLowerCase());
}
/* Reads and validates the event fields shared by create and update. */
function readEventBody(body, partial){
  const out = {};
  const has = k => body[k] !== undefined && body[k] !== null;
  if(has("title") || has("name") || !partial){
    out.title = vStr(body.title || body.name, "title", { required: true, min: 3, max: 160, label: "Event title" });
  }
  if(has("category") || !partial) out.category = vStr(body.category, "category", { max: 40 });
  if(has("description") || !partial) out.description = vStr(body.description, "description", { max: 8000 });
  if(has("venue") || !partial) out.venue = vStr(body.venue, "venue", { max: 200 });
  if(has("location") || !partial) out.location = vStr(body.location, "location", { max: 200 });
  if(has("event_date") || !partial) out.event_date = vDate(body.event_date, "Event date", true);
  if(has("start_time") || !partial) out.start_time = vTime(body.start_time, "Start time");
  if(has("end_time") || !partial) out.end_time = vTime(body.end_time, "End time");
  if(has("sales_start") || !partial) out.sales_start = vStr(body.sales_start, "sales start", { max: 32 });
  if(has("sales_end") || !partial) out.sales_end = vStr(body.sales_end, "sales end", { max: 32 });
  if(has("status")) out.status = vEnum(body.status, EVENT_STATUSES, "status", "draft");
  if(has("is_featured")) out.is_featured = (body.is_featured === true || body.is_featured === 1 || body.is_featured === "1" || body.is_featured === "true") ? 1 : 0;
  /* Optional per-event override. "organizer" (or an empty value) means "use my
     Active Payment Provider"; a named provider is only accepted by the route
     once it has been checked against this organizer's own configuration. */
  if(has("payment_provider")){
    const key = vStr(body.payment_provider, "payment provider", { max: 24 });
    if(key && key !== "organizer" && !isProviderKey(key)) throw err(422, "Invalid payment provider.", "VALIDATION");
    out.payment_provider = (key && key !== "organizer") ? key.toLowerCase() : null;
  }
  /* Who collects the money: "own" (the organizer's account) or "owner" (the
     platform owner's account). Empty means "use my account default". */
  if(has("payment_mode")){
    const mode = vStr(body.payment_mode, "payment mode", { max: 12 }).toLowerCase();
    if(mode && ["own","owner"].indexOf(mode) < 0) throw err(422, "Invalid payment mode.", "VALIDATION");
    out.payment_mode = mode === "owner" ? "owner" : (mode ? "own" : null);
  }
  /* Free-ticket verification settings. The Worker - not the browser - enforces
     the limit, and the threshold overrides are clamped to their safe bounds here
     so an out-of-range value can never be stored. */
  if(has("free_otp_enabled"))  out.free_otp_enabled = boolFlag(body.free_otp_enabled) ? 1 : 0;
  if(has("ip_abuse_enabled"))  out.ip_abuse_enabled = boolFlag(body.ip_abuse_enabled) ? 1 : 0;
  if(has("free_ticket_limit")) out.free_ticket_limit = clampInt(body.free_ticket_limit, FREE_TICKET_LIMIT_MIN, FREE_TICKET_LIMIT_MAX, 1);
  if(has("free_ticket_config")) out.free_ticket_config = normalizeFreeTicketConfig(body.free_ticket_config);
  return out;
}
/* GET/POST /api/organizer/events */
async function routeOrganizerEvents(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  if(request.method === "POST"){
    const body = await readJson(request);
    /* Two stages, because a per-user limit needs a proven identity:
       1. IP tier, before the challenge (a flood costs no Siteverify call)
       2. per-user tier, right after the Firebase UID is read from the token */
    await guardRate(env, request, "event_create", { skip: ["user"] });
    /* Event creation is the abuse-prone organizer write: the challenge is
       verified before the organizer lookup and before anything is stored. */
    await requireTurnstile(env, request, body, "event-create");
    await guardRate(env, request, "event_create", { uid: await callerUid(env, request), skip: ["ip"] });
    const organizer = await requireOrganizer(env, request);
    if(!organizer.org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
    const fields = readEventBody(body, false);
    const slug = await uniqueSlug(env, fields.title, null);
    /* Publishing is approved by the platform owner: an organizer asking for
       "active" gets "pending" and a request lands in the owners' inbox. */
    const status = organizerEventStatus(fields.status || "draft", organizer.user.role === "owner");
    /* AGREEMENT GATE (create): asking for a publish or an approval submission
       requires a signed agreement. Storing a plain draft never touches it. */
    let agreementGate = null;
    if(["active", "pending"].indexOf(String(fields.status || "")) >= 0 || String(status) === "active"){
      agreementGate = await requireAgreementForPublish(env, request, organizer.org.id,
        { source: "event_create", actor_user_id: organizer.user.id, actor_role: organizer.user.role });
    }
    const eventProvider = await checkEventProviderChoice(env, organizer.org.id, fields.payment_provider);
    const ins = await dbRun(env,
      "INSERT INTO events (organizer_id, title, slug, description, category, venue, location, event_date, start_time, end_time, status, is_featured, sales_start, sales_end, payment_provider, payment_mode, free_otp_enabled, free_ticket_limit, ip_abuse_enabled, free_ticket_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [organizer.org.id, fields.title, slug, fields.description || null, fields.category || null, fields.venue || null,
       fields.location || null, fields.event_date, fields.start_time || null, fields.end_time || null,
       status, fields.is_featured || 0, fields.sales_start || null, fields.sales_end || null, eventProvider,
       fields.payment_mode || null,
       fields.free_otp_enabled === undefined ? 1 : fields.free_otp_enabled,
       fields.free_ticket_limit === undefined ? 1 : fields.free_ticket_limit,
       fields.ip_abuse_enabled === undefined ? 1 : fields.ip_abuse_enabled,
       fields.free_ticket_config === undefined ? null : fields.free_ticket_config]);
    const id = (ins && ins.meta && ins.meta.last_row_id) ? ins.meta.last_row_id : null;
    if(!id) throw err(500, "We could not create your event. Please try again.", "EVENT_FAILED");
    if(agreementGate && String(status) === "active") await stampEventAgreement(env, id, agreementGate);
    const ev = await dbGet(env, eventSelectSql() + " WHERE e.id = ?", [id]);
    if(String(status) === "active") await notifyEventStatusEmail(env, ev, "draft", "active", request, ctx.ctx, "Published when the event was created.");
    else if(String(status) === "pending") await notifyEventApprovalRequestEmail(env, ev, organizer.org, request, ctx.ctx);
    return created({
      event: organizerEventPayload(ev),
      message: String(status) === "pending"
        ? "Your event was submitted and is waiting for approval. You will be emailed as soon as it is approved."
        : "Your event has been created as " + status + "."
    }, cors);
  }
  const session = await requireOrganizer(env, request);
  const where = [], params = [];
  if(session.org){ where.push("e.organizer_id = ?"); params.push(session.org.id); }
  else {
    /* event_staff only ever see the events they are assigned to */
    where.push("e.id IN (SELECT event_id FROM event_staff WHERE user_id = ?)");
    params.push(session.user.id);
  }
  const statusParam = vStr(url.searchParams.get("status"), "status", { max: 24 });
  if(statusParam && statusParam !== "all"){
    if(EVENT_STATUSES.indexOf(statusParam) < 0) throw err(422, "Invalid status filter.", "VALIDATION");
    where.push("e.status = ?"); params.push(statusParam);
  }
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(e.title LIKE ? OR e.venue LIKE ? OR e.location LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like);
  }
  const whereSql = " WHERE " + where.join(" AND ");
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM events e" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const sortKey = String(url.searchParams.get("sort") || "soonest");
  const orderBy = sortKey === "newest" ? "e.created_at DESC" : (sortKey === "latest" ? "e.event_date DESC" : "e.event_date ASC, e.start_time ASC");
  const rows = await dbAll(env,
    "SELECT e.*, (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.event_id = e.id AND o.status = 'paid') AS tickets_sold, " +
    "(SELECT COALESCE(SUM(o.total_amount),0) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid') AS revenue, " +
    "(SELECT MIN(tt.price) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'active') AS starting_price, " +
    "(SELECT SUM(MAX(0, tt.quantity - tt.sold)) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'active') AS available_total " +
    "FROM events e" + whereSql + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?", params.concat([p.limit, p.offset]));
  return ok({
    events: rows.map(organizerEventPayload),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
/* GET/PUT/DELETE /api/organizer/events/:id */
async function routeOrganizerEvent(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  const id = vInt(ctx.params.id, "event", { min: 1, label: "Event id" });
  const session = await requireOrganizer(env, request);
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [id]);
  if(!ev) throw err(404, "Event not found.", "NOT_FOUND");
  const ownsIt = session.org && Number(ev.organizer_id) === Number(session.org.id);
  if(!ownsIt && session.user.role !== "owner") throw err(403, "You do not have access to this event.", "FORBIDDEN");
  if(request.method === "GET"){
    const row = await dbGet(env, eventSelectSql() + " WHERE e.id = ?", [id]);
    const tickets = await dbAll(env, "SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC, id ASC", [id]);
    const sold = await dbGet(env, "SELECT COALESCE(SUM(quantity),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.event_id = ? AND o.status = 'paid'", [id]);
    const rev = await dbGet(env, "SELECT COALESCE(SUM(total_amount),0) AS n FROM orders WHERE event_id = ? AND status = 'paid'", [id]);
    const payload = organizerEventPayload(row);
    payload.tickets_sold = sold ? Number(sold.n) : 0;
    payload.revenue = rev ? Number(rev.n) : 0;
    payload.tickets = tickets.map(publicTicketType);
    payload.tickets_url = appBase(env, request) + "/event/?slug=" + encodeURIComponent(ev.slug);
    /* The provider this event will actually be sold through, using the one
       documented priority order (event override -> organizer active provider). */
    const resolved = await resolveEffectiveProvider(env, { event: ev });
    payload.effective_payment_provider = resolved.configured ? resolved.provider_key : null;
    payload.effective_payment_provider_label = resolved.configured ? providerLabel(resolved.provider_key) : null;
    payload.payment_provider_source = resolved.configured ? resolved.source : null;
    payload.payment_provider_ready = !!resolved.configured;
    payload.payment_provider_message = resolved.configured ? null : providerProblemMessage(resolved);
    /* Money split for THIS event: owner-account vs organizer-account paid totals
       from the frozen per-order snapshot - stays correct across mode flips. */
    try {
      const cols = await moneyTrailCols(env);
      if(cols.collected_via){
        const ms = await dbGet(env,
          "SELECT COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN total_amount ELSE 0 END),0) AS owner_amount, " +
          "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN 1 ELSE 0 END),0) AS owner_count, " +
          "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN total_amount ELSE 0 END),0) AS organizer_amount, " +
          "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN 1 ELSE 0 END),0) AS organizer_count " +
          "FROM orders WHERE event_id = ?", [id]);
        payload.owner_collected_amount = Number((ms && ms.owner_amount) || 0);
        payload.owner_collected_count = Number((ms && ms.owner_count) || 0);
        payload.organizer_collected_amount = Number((ms && ms.organizer_amount) || 0);
        payload.organizer_collected_count = Number((ms && ms.organizer_count) || 0);
        payload.money_split = { owner_amount: payload.owner_collected_amount, owner_count: payload.owner_collected_count,
          organizer_amount: payload.organizer_collected_amount, organizer_count: payload.organizer_collected_count };
      }
    } catch(e){ /* pre-migration: fields simply absent */ }
    /* Aggregate free-ticket verification/abuse numbers for the dashboard. A
       database that has not run migration 0006 yet reports null rather than
       failing the whole event read. */
    let freeStats = null;
    try { freeStats = await freeTicketStats(env, id); } catch(e){ freeStats = null; }
    payload.free_ticket_stats = freeStats;
    return ok({ event: payload, tickets: payload.tickets, free_ticket_stats: freeStats }, cors);
  }
  if(!ownsIt) throw err(403, "Only the event owner can change this event.", "FORBIDDEN");
  if(request.method === "DELETE"){
    const paid = await dbGet(env, "SELECT COUNT(*) AS n FROM orders WHERE event_id = ? AND status = 'paid'", [id]);
    if(paid && Number(paid.n) > 0){
      /* Paid orders exist, so the record is preserved: cancel instead of delete. */
      await dbRun(env, "UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?", [touch(), id]);
      const cancelled = await dbGet(env, "SELECT * FROM events WHERE id = ?", [id]);
      await notifyEventStatusEmail(env, cancelled, ev.status, "cancelled", request, ctx.ctx,
        "This event was cancelled by the organizer.");
      return ok({ event_id: id, status: "cancelled", message: "This event has paid orders, so it was cancelled rather than deleted." }, cors);
    }
    await dbRun(env, "DELETE FROM events WHERE id = ?", [id]);
    return ok({ deleted: true, event_id: id, message: "Event deleted." }, cors);
  }
  if(request.method === "PUT"){
    const body = await readJson(request);
    const fields = readEventBody(body, true);
    /* An organizer asking for "active" is really asking for approval: the event
       is stored as "pending" and the owners are emailed once per submission. */
    const ownerSelf = session.user.role === "owner";
    let submittedForApproval = false;
    if(fields.status !== undefined){
      fields.status = organizerEventStatus(fields.status, ownerSelf);
      submittedForApproval = String(fields.status) === "pending" && String(ev.status) !== "pending";
    }
    /* AGREEMENT GATE (update): moving an event that is NOT already on the
       publication track onto it (draft/paused/ended/cancelled -> active or
       pending) requires a signed agreement. A status that is simply unchanged
       is a pure edit, so already-published, grandfathered events stay
       editable without re-signing - the terms only re-check on republish. */
    let agreementGate = null;
    if(fields.status !== undefined){
      const target = String(fields.status);
      const alreadyPublic = String(ev.status) === "active" || String(ev.status) === "pending";
      const ontoTrack = (target === "active" || target === "pending") && !alreadyPublic;
      const toActive = target === "active" && String(ev.status) !== "active";
      if(ontoTrack || toActive){
        agreementGate = await requireAgreementForPublish(env, request, ev.organizer_id,
          { source: "event_update", event_id: id, actor_user_id: session.user.id, actor_role: session.user.role });
      }
    }
    if(fields.payment_provider !== undefined){
      fields.payment_provider = await checkEventProviderChoice(env, ev.organizer_id, fields.payment_provider);
    }
    const sets = [], params = [];
    if(fields.title !== undefined){
      sets.push("title = ?"); params.push(fields.title);
      sets.push("slug = ?"); params.push(await uniqueSlug(env, fields.title, id));
    }
    for(const key of ["description", "category", "venue", "location", "event_date", "start_time", "end_time", "sales_start", "sales_end", "status", "is_featured", "payment_provider", "payment_mode", "free_otp_enabled", "free_ticket_limit", "ip_abuse_enabled", "free_ticket_config"]){
      if(fields[key] !== undefined){ sets.push(key + " = ?"); params.push(fields[key]); }
    }
    if(!sets.length) throw err(422, "There is nothing to update.", "VALIDATION");
    if(fields.status === "active" || fields.status === "pending"){
      const tt = await dbGet(env, "SELECT COUNT(*) AS n FROM ticket_types WHERE event_id = ? AND status = 'active'", [id]);
      if(!tt || Number(tt.n) === 0) throw err(409, "Add at least one ticket type before publishing this event.", "NO_TICKETS");
    }
    sets.push("updated_at = ?"); params.push(touch());
    params.push(id);
    await dbRun(env, "UPDATE events SET " + sets.join(", ") + " WHERE id = ?", params);
    if(agreementGate) await stampEventAgreement(env, id, agreementGate);
    const row = await dbGet(env, eventSelectSql() + " WHERE e.id = ?", [id]);
    if(fields.status !== undefined && String(fields.status) !== String(ev.status)){
      if(String(fields.status) === "pending"){
        await notifyEventApprovalRequestEmail(env, row, null, request, ctx.ctx);
      } else {
        await notifyEventStatusEmail(env, row, ev.status, fields.status, request, ctx.ctx,
          fields.status === "cancelled" ? "This event was cancelled by the organizer." : "");
      }
    }
    return ok({
      event: organizerEventPayload(row),
      submitted_for_approval: submittedForApproval,
      message: submittedForApproval
        ? "Your event was submitted and is waiting for approval. You will be emailed as soon as it is approved."
        : "Event updated."
    }, cors);
  }
  throw err(405, "That method is not allowed here.", "METHOD");
}
/* ------------------------------------------------------- uploads (R2) ------
   The original filename is never trusted: the extension comes from the
   validated MIME type, the object key is generated here, and the bytes are
   checked against the real file signature before anything is stored. */
const IMAGE_MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
function signatureMatches(bytes, ext){
  const b = new Uint8Array(bytes);
  if(b.length < 12) return false;
  if(ext === "jpg") return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  if(ext === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  if(ext === "webp") return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}
async function readImageUpload(request, fieldNames){
  let form = null;
  try { form = await request.formData(); }
  catch(e){ throw err(400, "The upload could not be read. Please try again.", "BAD_UPLOAD"); }
  let file = null;
  for(const name of fieldNames){
    const candidate = form.get(name);
    if(candidate && typeof candidate === "object" && typeof candidate.arrayBuffer === "function"){ file = candidate; break; }
  }
  if(!file) throw err(422, "Choose a JPG, PNG or WEBP image to upload.", "NO_FILE");
  const ext = POSTER_TYPES[String(file.type || "").toLowerCase()];
  if(!ext) throw err(422, "Use a JPG, PNG or WEBP image (maximum 5 MB).", "BAD_TYPE");
  if(Number(file.size) > MAX_POSTER_BYTES) throw err(422, "That image is larger than 5 MB. Please choose a smaller file.", "TOO_LARGE");
  const bytes = await file.arrayBuffer();
  if(bytes.byteLength > MAX_POSTER_BYTES) throw err(422, "That image is larger than 5 MB. Please choose a smaller file.", "TOO_LARGE");
  if(!signatureMatches(bytes, ext)) throw err(422, "That file is not a valid " + ext.toUpperCase() + " image.", "BAD_SIGNATURE");
  return { ext: ext, bytes: bytes, content_type: IMAGE_MIME[ext] };
}
async function putImage(env, key, upload){
  try {
    await env.BUCKET.put(key, upload.bytes, { httpMetadata: { contentType: upload.content_type } });
  } catch(e){
    console.error("R2_PUT_ERROR", (e && e.message) || String(e));
    throw err(500, "We could not store that image. Please try again.", "STORAGE_FAILED");
  }
}
async function deleteImage(env, key){
  if(!key || !MEDIA_KEY_RE.test(key)) return;
  try { await env.BUCKET.delete(key); } catch(e){ /* the D1 pointer is cleared regardless */ }
}
/* POST / DELETE /api/organizer/events/:id/poster */
async function routeOrganizerPoster(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "poster", {});
  const id = vInt(ctx.params.id, "event", { min: 1, label: "Event id" });
  const session = await requireOrganizer(env, request);
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [id]);
  if(!ev) throw err(404, "Event not found.", "NOT_FOUND");
  const ownsIt = session.org && Number(ev.organizer_id) === Number(session.org.id);
  if(!ownsIt && session.user.role !== "owner") throw err(403, "You do not have access to this event.", "FORBIDDEN");
  if(request.method === "DELETE"){
    await deleteImage(env, ev.poster_key);
    await dbRun(env, "UPDATE events SET poster_url = NULL, poster_key = NULL, updated_at = ? WHERE id = ?", [touch(), ev.id]);
    const row = await dbGet(env, eventSelectSql() + " WHERE e.id = ?", [ev.id]);
    return ok({ event: organizerEventPayload(row), poster_url: null, message: "Poster removed." }, corsFor(env, request));
  }
  const upload = await readImageUpload(request, ["poster", "file", "image", "poster_file", "upload"]);
  const key = "events/" + ev.id + "/" + randomCode(16).toLowerCase() + "." + upload.ext;
  await putImage(env, key, upload);
  const url = mediaUrlFor(request, key);
  await dbRun(env, "UPDATE events SET poster_url = ?, poster_key = ?, updated_at = ? WHERE id = ?", [url, key, touch(), ev.id]);
  if(ev.poster_key && ev.poster_key !== key) await deleteImage(env, ev.poster_key);
  const row = await dbGet(env, eventSelectSql() + " WHERE e.id = ?", [ev.id]);
  return created({ event: organizerEventPayload(row), poster_url: url, poster_key: key, message: "Poster updated." }, corsFor(env, request));
}
/* POST /api/organizer/logo */
async function routeOrganizerLogo(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "logo", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const upload = await readImageUpload(request, ["logo", "file", "image", "upload"]);
  const key = "organizers/" + org.id + "/" + randomCode(16).toLowerCase() + "." + upload.ext;
  await putImage(env, key, upload);
  const url = mediaUrlFor(request, key);
  await dbRun(env, "UPDATE organizers SET logo_url = ?, logo_key = ?, updated_at = ? WHERE id = ?", [url, key, touch(), org.id]);
  if(org.logo_key && org.logo_key !== key) await deleteImage(env, org.logo_key);
  const fresh = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [org.id]);
  const { user } = await requireAuth(env, request);
  const payload = mePayload(user, fresh);
  return created(Object.assign({}, payload, { logo_url: url, role: user.role, message: "Logo updated." }), corsFor(env, request));
}
/* ------------------------------------------------------- ticket types ------ */
async function eventForWrite(env, request, eventId){
  const session = await requireOrganizer(env, request);
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [eventId]);
  if(!ev) throw err(404, "Event not found.", "NOT_FOUND");
  const ownsIt = session.org && Number(ev.organizer_id) === Number(session.org.id);
  if(!ownsIt && session.user.role !== "owner") throw err(403, "You do not have access to this event.", "FORBIDDEN");
  return { session: session, event: ev, can_write: true };
}
function readTicketTypeBody(body, partial){
  const out = {};
  const has = k => body[k] !== undefined && body[k] !== null;
  if(has("name") || !partial) out.name = vStr(body.name, "name", { required: true, min: 2, max: 80, label: "Ticket name" });
  if(has("description") || !partial) out.description = vStr(body.description, "description", { max: 500 });
  if(has("price") || !partial) out.price = vInt(body.price, "price", { min: 0, label: "Price" });
  if(has("quantity") || !partial) out.quantity = vInt(body.quantity, "quantity", { min: 1, label: "Quantity" });
  if(has("sales_start") || !partial) out.sales_start = vStr(body.sales_start, "sales start", { max: 32 });
  if(has("sales_end") || !partial) out.sales_end = vStr(body.sales_end, "sales end", { max: 32 });
  if(has("status")) out.status = vEnum(body.status, TICKET_TYPE_STATUSES, "status", "active");
  return out;
}
/* GET/POST /api/organizer/events/:id/tickets */
async function routeOrganizerTickets(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  const id = vInt(ctx.params.id, "event", { min: 1, label: "Event id" });
  await eventForWrite(env, request, id);
  if(request.method === "GET"){
    const rows = await dbAll(env,
      "SELECT tt.*, (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.ticket_type_id = tt.id AND o.status = 'paid') AS paid_quantity " +
      "FROM ticket_types tt WHERE tt.event_id = ? ORDER BY tt.price ASC, tt.id ASC", [id]);
    return ok({
      tickets: rows.map(t => Object.assign(publicTicketType(t), { paid_quantity: Number(t.paid_quantity || 0) })),
      event_id: id
    }, cors);
  }
  if(request.method === "POST"){
    await guardRate(env, request, "ticket_type", {});
    const body = await readJson(request);
    const fields = readTicketTypeBody(body, false);
    const ins = await dbRun(env,
      "INSERT INTO ticket_types (event_id, name, description, price, quantity, sold, sales_start, sales_end, status) VALUES (?,?,?,?,?,0,?,?,?)",
      [id, fields.name, fields.description || null, fields.price, fields.quantity,
       fields.sales_start || null, fields.sales_end || null, fields.status || "active"]);
    const newId = (ins && ins.meta && ins.meta.last_row_id) ? ins.meta.last_row_id : null;
    if(!newId) throw err(500, "We could not save that ticket type. Please try again.", "TICKET_TYPE_FAILED");
    const row = await dbGet(env, "SELECT * FROM ticket_types WHERE id = ?", [newId]);
    return created({ ticket: publicTicketType(row), message: fields.name + " has been added." }, cors);
  }
  throw err(405, "That method is not allowed here.", "METHOD");
}
/* PUT/DELETE /api/organizer/events/:id/tickets/:tid  and  /api/organizer/tickets/:tid
   Both shapes are supported so the organizer screens and any direct API client
   can use whichever is convenient. */
async function routeOrganizerTicketWrite(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  const ticketId = vInt(ctx.params.tid || ctx.params.id, "ticket", { min: 1, label: "Ticket type id" });
  const tt = await dbGet(env, "SELECT * FROM ticket_types WHERE id = ?", [ticketId]);
  if(!tt) throw err(404, "That ticket type does not exist.", "NOT_FOUND");
  await eventForWrite(env, request, tt.event_id);
  if(ctx.params.id && ctx.params.tid && Number(ctx.params.id) !== Number(tt.event_id)){
    throw err(409, "That ticket type belongs to a different event.", "EVENT_MISMATCH");
  }
  if(request.method === "DELETE"){
    const used = await dbGet(env,
      "SELECT COALESCE(SUM(oi.quantity),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.ticket_type_id = ? AND o.status = 'paid'", [ticketId]);
    if(used && Number(used.n) > 0){
      /* Tickets were already sold: keep the record for those attendees and stop
         selling instead of destroying their ticket type. */
      await dbRun(env, "UPDATE ticket_types SET status = 'hidden', updated_at = ? WHERE id = ?", [touch(), ticketId]);
      return ok({ ticket_id: ticketId, status: "hidden", message: "Tickets have already been sold for this type, so it was hidden instead of deleted." }, cors);
    }
    await dbRun(env, "DELETE FROM ticket_types WHERE id = ?", [ticketId]);
    return ok({ deleted: true, ticket_id: ticketId, message: "Ticket type deleted." }, cors);
  }
  if(request.method === "PUT"){
    const body = await readJson(request);
    const fields = readTicketTypeBody(body, true);
    const sets = [], params = [];
    for(const key of ["name", "description", "price", "sales_start", "sales_end", "status"]){
      if(fields[key] !== undefined){ sets.push(key + " = ?"); params.push(fields[key]); }
    }
    if(fields.quantity !== undefined){
      if(fields.quantity < Number(tt.sold)){
        throw err(409, "You cannot set the quantity below the " + tt.sold + " tickets already sold.", "QUANTITY_TOO_LOW");
      }
      sets.push("quantity = ?"); params.push(fields.quantity);
    }
    if(!sets.length) throw err(422, "There is nothing to update.", "VALIDATION");
    sets.push("updated_at = ?"); params.push(touch());
    params.push(ticketId);
    await dbRun(env, "UPDATE ticket_types SET " + sets.join(", ") + " WHERE id = ?", params);
    const row = await dbGet(env, "SELECT * FROM ticket_types WHERE id = ?", [ticketId]);
    return ok({ ticket: publicTicketType(row), message: "Ticket type updated." }, cors);
  }
  throw err(405, "That method is not allowed here.", "METHOD");
}
/* PUT /api/organizer/profile */
async function routeOrganizerProfile(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  const { user, org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const body = await readJson(request);
  const businessName = vStr(body.business_name, "business name", { max: 160, label: "Business name" });
  const businessEmail = vEmail(body.business_email, "business email", false);
  const businessPhone = vPhone(body.business_phone, "business phone", false);
  const fullName = vStr(body.full_name, "full name", { min: 3, max: 120, label: "Full name" });
  const phone = vPhone(body.phone, "phone", false);
  await dbRun(env, "UPDATE organizers SET business_name = ?, business_email = ?, business_phone = ?, updated_at = ? WHERE id = ?",
    [businessName || org.business_name, businessEmail || org.business_email, businessPhone || org.business_phone, touch(), org.id]);
  /* Owner payment mode is an account-wide default; the per-event choice still
     overrides it. Only the owner of the profile can set it. */
  if(body.use_owner_payments !== undefined){
    const on = (body.use_owner_payments === true || body.use_owner_payments === "true" || body.use_owner_payments === 1 || body.use_owner_payments === "1") ? 1 : 0;
    await dbRun(env, "UPDATE organizers SET use_owner_payments = ?, updated_at = ? WHERE id = ?", [on, touch(), org.id]);
  }
  if(fullName || phone){
    await dbRun(env, "UPDATE users SET full_name = ?, phone = ?, updated_at = ? WHERE id = ?",
      [fullName || user.full_name, phone || user.phone, touch(), user.id]);
  }
  const freshOrg = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [org.id]);
  const freshUser = await dbGet(env, "SELECT * FROM users WHERE id = ?", [user.id]);
  const payload = mePayload(freshUser, freshOrg);
  return ok(Object.assign({}, payload, { role: freshUser.role, message: "Your settings have been saved." }), cors);
}
/* PUT /api/organizer/payment-settings is defined with the provider settings
   helpers below, together with the connection test. */
/* ============================================================================
   ORGANIZER PAYMENT SETTINGS
   ----------------------------------------------------------------------------
   One storage model, two API shapes. The unified routes are:
     GET    /api/organizer/payment-providers            all three + their state
     POST   /api/organizer/payment-providers/:provider  connect / update one
     DELETE /api/organizer/payment-providers/:provider  disconnect that one
     POST   /api/organizer/payment-providers/:provider/test
     POST   /api/organizer/payment-provider/select       set the active provider
     GET    /api/organizer/payment-provider/status      active provider + states
   The pre-PayHero routes (GET/PUT /api/organizer/payment-settings and
   POST /api/organizer/payment-settings/test) are served by this same code, so a
   bookmarked call or a cached page keeps working.

   Secrets are AES-GCM encrypted with the PAYMENT_ENCRYPTION_KEY Worker secret
   before they touch D1 and are never returned to a client: the UI only ever
   receives non-secret identifiers and "has_..." indicators.
   ========================================================================== */
const PROVIDER_METHODS = {
  pesapal: "M-Pesa, cards and the other methods on your Pesapal account",
  paystack: "M-Pesa, cards and the other methods on your Paystack account",
  payhero: "M-Pesa (STK) and the Kenyan channels on your PayHero account"
};
const PROVIDER_BRAND = {
  pesapal: { mark: "PE", color: "#0B4DA2" },
  paystack: { mark: "PS", color: "#00C3F7" },
  payhero: { mark: "PH", color: "#0AA679" }
};
/* One card per provider for the Payment Settings page. */
async function providerCard(env, settings, providerKey, row){
  const state = await providerState(env, settings, providerKey, row);
  const provider = PROVIDERS[providerKey] || null;
  const capabilities = (provider && provider.capabilities) || {};
  return Object.assign({
    key: providerKey,
    label: providerLabel(providerKey),
    logo_mark: PROVIDER_BRAND[providerKey].mark,
    logo_color: PROVIDER_BRAND[providerKey].color,
    methods: PROVIDER_METHODS[providerKey],
    required_fields: PROVIDER_FIELDS[providerKey].slice(),
    test_supported: typeof (provider && provider.test) === "function",
    checkout_mode: capabilities.stk_push ? "stk_push" : "redirect",
    refund_supported: !!capabilities.refunds,
    platform_credentials: await platformConfigured(env, providerKey)
  }, state, {
    /* Only a provider the organizer actually connected, with testing enabled and
       no recorded error, can be chosen as the active one. */
    available: state.configured && state.enabled && state.status !== "error"
  });
}
async function providerCards(env, settings, rows){
  const out = [];
  for(const key of PAYMENT_PROVIDER_KEYS) out.push(await providerCard(env, settings, key, (rows || {})[key] || null));
  return out;
}
/* Which provider is active, and is it usable right now? */
async function activeProviderView(env, settings, rows){
  const key = providerKeyOf(settings);
  const resolved = await resolveEffectiveProvider(env, { settings: settings, rows: rows || {}, organizer_id: settings ? settings.organizer_id : null });
  return {
    provider: key,
    provider_label: providerLabel(key),
    event_provider: null,
    connected: !!resolved.configured,
    credentials_source: resolved.configured ? resolved.creds.source : null,
    resolved_provider: resolved.configured ? resolved.provider_key : null,
    available_providers: PAYMENT_PROVIDER_KEYS.filter(k => {
      const row = (rows || {})[k] || null;
      return row ? (Number(row.enabled) !== 0 && rowConfigured(k, row)) : false;
    }),
    message: resolved.configured ? null : providerProblemMessage(resolved)
  };
}
/* The shape the pre-PayHero /api/organizer/payment-settings routes returned,
   produced from the unified model so an older cached page keeps working - and
   still never receives a secret. */
function settingsView(s, activeKey, activeState){
  const base = {
    id: s ? s.id : null,
    organizer_id: s ? s.organizer_id : null,
    provider: activeKey || "paystack",
    status: (activeState && activeState.status) || (s && s.status) || "not_connected",
    public_key: null, consumer_key: null, ipn_id: null, api_username: null, channel_id: null,
    has_secret_key: false, has_consumer_secret: false, has_password: false,
    secret_key_masked: "", consumer_secret_masked: "", password_masked: "",
    last_tested_at: null, last_error: null, updated_at: s ? s.updated_at : null,
    connected: !!(activeState && activeState.configured),
    credentials_source: (activeState && activeState.credentials_source) || null
  };
  const fields = (activeState && activeState.fields) ? activeState.fields : null;
  if(fields){
    base.public_key = fields.public_key;
    base.consumer_key = fields.consumer_key;
    base.ipn_id = fields.ipn_id;
    base.api_username = fields.api_username;
    base.channel_id = fields.channel_id;
    base.has_secret_key = fields.has_secret_key;
    base.has_consumer_secret = fields.has_consumer_secret;
    base.has_password = fields.has_password;
  }
  base.secret_key_masked = base.has_secret_key ? "Stored (hidden)" : "";
  base.consumer_secret_masked = base.has_consumer_secret ? "Stored (hidden)" : "";
  base.password_masked = base.has_password ? "Stored (hidden)" : "";
  return base;
}
/* Older callers only needed the static catalogue; it is now derived from the
   same three providers, so there is one list in the codebase. */
async function providerCatalog(env){
  return (await providerCards(env, null, {})).map(card => ({
    key: card.key, label: card.label, fields: card.required_fields,
    platform_credentials: card.platform_credentials
  }));
}
/* Writes one provider's configuration for one organizer. Secrets are encrypted
   here and nowhere else; a blank input keeps whatever ciphertext is already
   stored, so an update never wipes a saved key by accident. */
async function saveProviderConfig(env, organizerId, providerKey, body, existingRow){
  const row = existingRow || {};
  const now = touch();
  const next = {
    public_key: row.public_key || null,
    consumer_key: row.consumer_key || null,
    api_username: row.api_username || null,
    channel_id: (row.channel_id === undefined || row.channel_id === null) ? null : String(row.channel_id),
    ipn_id: row.ipn_id || null,
    secret_key_encrypted: row.secret_key_encrypted || null,
    consumer_secret_encrypted: row.consumer_secret_encrypted || null,
    password_encrypted: row.password_encrypted || null,
    status: CONNECTION_STATUSES.indexOf(String(row.status)) > -1 ? String(row.status) : "not_connected",
    last_tested_at: row.last_tested_at || null,
    last_error: row.last_error || null,
    enabled: (row.enabled === undefined || row.enabled === null) ? 1 : Number(row.enabled)
  };
  const truthy = v => v === true || v === 1 || v === "1" || v === "true";
  if(body.enabled !== undefined) next.enabled = truthy(body.enabled) ? 1 : 0;
  if(truthy(body.reset)){ next.status = "not_connected"; next.last_error = null; next.last_tested_at = null; }
  if(providerKey === "paystack"){
    const publicKey = vStr(body.public_key, "public key", { max: 200 });
    const secretKey = vStr(body.secret_key, "secret key", { max: 400 });
    if(publicKey) next.public_key = publicKey;
    if(secretKey) next.secret_key_encrypted = await encryptSecret(env, secretKey);
  } else if(providerKey === "pesapal"){
    const consumerKey = vStr(body.consumer_key, "consumer key", { max: 200 });
    const consumerSecret = vStr(body.consumer_secret, "consumer secret", { max: 400 });
    if(consumerKey) next.consumer_key = consumerKey;
    if(consumerSecret) next.consumer_secret_encrypted = await encryptSecret(env, consumerSecret);
  } else if(providerKey === "payhero"){
    const apiUsername = vStr(body.api_username, "api username", { max: 120 });
    const password = vStr(body.password, "api password", { max: 400 });
    const channelId = vStr(body.channel_id, "channel id", { max: 40 });
    if(apiUsername) next.api_username = apiUsername;
    if(password) next.password_encrypted = await encryptSecret(env, password);
    if(channelId) next.channel_id = channelId;
  }
  if(next.channel_id !== null) next.channel_id = String(next.channel_id).replace(/[^0-9]/g, "") || String(next.channel_id);
  const complete = rowConfigured(providerKey, next);
  const touched = !!(body.public_key || body.secret_key || body.consumer_key || body.consumer_secret
    || body.api_username || body.password || body.channel_id);
  if(touched) next.last_error = null;
  /* Status follows completeness, never a claim: an incomplete row stays
     "configuration_required" until every required field is present. */
  if(!complete) next.status = rowPartial(providerKey, next) ? "configuration_required" : "not_connected";
  else if(touched || next.status === "not_connected" || next.status === "configuration_required") next.status = "connected";
  if(row.id){
    await dbRun(env,
      "UPDATE organizer_payment_providers SET status = ?, enabled = ?, public_key = ?, consumer_key = ?, ipn_id = ?, api_username = ?, channel_id = ?, secret_key_encrypted = ?, consumer_secret_encrypted = ?, password_encrypted = ?, last_tested_at = ?, last_error = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ?",
      [next.status, next.enabled, next.public_key, next.consumer_key, next.ipn_id, next.api_username, next.channel_id,
       next.secret_key_encrypted, next.consumer_secret_encrypted, next.password_encrypted,
       next.last_tested_at, next.last_error, now, now, row.id]);
  } else {
    await dbRun(env,
      "INSERT INTO organizer_payment_providers (organizer_id, provider, status, enabled, public_key, consumer_key, ipn_id, api_username, channel_id, secret_key_encrypted, consumer_secret_encrypted, password_encrypted, last_tested_at, last_error, connected_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [organizerId, providerKey, next.status, next.enabled, next.public_key, next.consumer_key, next.ipn_id,
       next.api_username, next.channel_id, next.secret_key_encrypted, next.consumer_secret_encrypted,
       next.password_encrypted, next.last_tested_at, next.last_error,
       next.status === "connected" ? now : null, now]);
  }
  return loadProviderRow(env, organizerId, providerKey);
}
/* A fact a provider hands back at runtime (today: the Pesapal IPN id) is stored
   in that provider's own row, and mirrored into payment_settings so a rollback
   to the previous code still finds it. `column` is always a literal from this
   file, never anything a request supplied. */
async function rememberProviderField(env, providerKey, organizerId, column, value){
  if(!organizerId) return;
  const row = await loadProviderRow(env, organizerId, providerKey);
  if(row){
    await dbRun(env, "UPDATE organizer_payment_providers SET " + column + " = ?, updated_at = ? WHERE id = ?",
      [value, touch(), row.id]);
  }
  await dbRun(env, "UPDATE payment_settings SET " + column + " = ?, updated_at = ? WHERE organizer_id = ?",
    [value, touch(), organizerId]);
}
/* Records the organizer's Active Payment Provider. Also mirrors the credentials
   into the legacy payment_settings columns so a rollback to the previous code
   finds the same account, and never leaks them to a client. */
async function setActiveProvider(env, organizerId, providerKey, existingSettings, state){
  const now = touch();
  const status = state.status === "error" ? "error" : (state.configured ? "connected" : "configuration_required");
  const row = await loadProviderRow(env, organizerId, providerKey);
  try {
    if(existingSettings){
      await dbRun(env, "UPDATE payment_settings SET provider = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?",
        [providerKey, status, state.last_error || null, now, existingSettings.id]);
    } else {
      await dbRun(env, "INSERT INTO payment_settings (organizer_id, provider, status) VALUES (?,?,?)",
        [organizerId, providerKey, status]);
    }
    if(row && providerKey === "paystack"){
      await dbRun(env, "UPDATE payment_settings SET public_key = ?, secret_key_encrypted = ? WHERE organizer_id = ?",
        [row.public_key || null, row.secret_key_encrypted || null, organizerId]);
    }
    if(row && providerKey === "pesapal"){
      await dbRun(env, "UPDATE payment_settings SET consumer_key = ?, consumer_secret_encrypted = ?, ipn_id = ? WHERE organizer_id = ?",
        [row.consumer_key || null, row.consumer_secret_encrypted || null, row.ipn_id || null, organizerId]);
    }
  } catch(e){
    /* A pre-migration database has a CHECK constraint that rejects 'payhero'.
       Say exactly what is wrong instead of surfacing a raw D1 error. */
    if(/CHECK|constraint/i.test(String((e && e.message) || ""))){
      throw err(500, "This server's database has not been migrated yet. Run worker/migrations/0002_payhero.sql before choosing a payment provider.", "MIGRATION_REQUIRED");
    }
    throw e;
  }
  return loadPaymentSettings(env, organizerId);
}
/* Everything one organizer needs to render the whole Payment Settings page:
   the three cards, the active provider and the connection state, in one call. */
async function paymentOverview(env, organizerId){
  const settings = await loadPaymentSettings(env, organizerId);
  const rows = await loadProviderRows(env, organizerId);
  const active = await activeProviderView(env, settings, rows);
  const cards = await providerCards(env, settings, rows);
  const activeCard = cards.filter(c => c.key === active.provider)[0] || null;
  return {
    settings: settings,
    rows: rows,
    cards: cards,
    active: active,
    active_card: activeCard,
    settings_view: settingsView(settings, active.provider, activeCard)
  };
}
/* GET /api/organizer/payment-providers, and the legacy
   GET /api/organizer/payment-settings, both return this one shape. */
async function routePaymentProvidersGet(ctx){
  const env = ctx.env, request = ctx.request;
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const view = await paymentOverview(env, org.id);
  return ok({
    provider: view.active.provider,
    provider_label: view.active.provider_label,
    providers: view.cards,
    payment_providers: view.cards,
    active_provider: view.active,
    payment_settings: view.settings_view,
    connected: view.active.connected,
    credentials_source: view.active.credentials_source
  }, corsFor(env, request));
}
/* GET /api/organizer/payment-provider/status - the small version the event
   screens use to show which provider an event is sold through. */
async function routePaymentProviderStatus(ctx){
  const env = ctx.env, request = ctx.request;
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const view = await paymentOverview(env, org.id);
  return ok({
    provider: view.active.provider,
    provider_label: view.active.provider_label,
    active_provider: view.active,
    providers: view.cards
  }, corsFor(env, request));
}
/* POST /api/organizer/payment-providers/:provider - connect or update ONE
   provider. The organizer comes from the verified Firebase token, never from the
   body, so organizer A can only ever write organizer A's own row. */
async function routeProviderPut(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const providerKey = vEnum(ctx.params.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  const body = await readJson(request);
  const existing = await loadProviderRow(env, org.id, providerKey);
  await saveProviderConfig(env, org.id, providerKey, body, existing);
  const view = await paymentOverview(env, org.id);
  const card = view.cards.filter(c => c.key === providerKey)[0];
  return ok({
    saved: true,
    provider: providerKey,
    provider_label: providerLabel(providerKey),
    provider_card: card,
    providers: view.cards,
    active_provider: view.active,
    payment_settings: view.settings_view,
    message: providerLabel(providerKey) + " settings saved. Run a connection test to confirm they work."
  }, cors);
}
/* DELETE /api/organizer/payment-providers/:provider - disconnect just this one.
   Paid orders and issued tickets are untouched; only future checkout is closed,
   and never a silent switch to a different gateway. */
async function routeProviderDelete(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const providerKey = vEnum(ctx.params.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  const settings = await loadPaymentSettings(env, org.id);
  await dbRun(env, "DELETE FROM organizer_payment_providers WHERE organizer_id = ? AND provider = ?", [org.id, providerKey]);
  if(settings && String(settings.provider) === providerKey){
    await dbRun(env, "DELETE FROM payment_settings WHERE organizer_id = ?", [org.id]);
  }
  const view = await paymentOverview(env, org.id);
  return ok({
    disconnected: true,
    provider: providerKey,
    provider_label: providerLabel(providerKey),
    providers: view.cards,
    active_provider: view.active,
    payment_settings: view.settings_view,
    message: providerLabel(providerKey) + " has been disconnected. Past orders and tickets are unchanged."
  }, cors);
}
/* POST /api/organizer/payment-provider/select - the Active Payment Provider.
   Only a provider that is successfully configured can become active. */
async function routeProviderSelect(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const body = await readJson(request);
  const providerKey = vEnum(body.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider to make active.", "VALIDATION");
  const settings = await loadPaymentSettings(env, org.id);
  const row = await loadProviderRow(env, org.id, providerKey);
  const state = await providerState(env, settings, providerKey, row);
  if(!state.configured || !state.enabled || state.status === "error"){
    throw err(422, providerLabel(providerKey) + " is not connected yet, so it cannot be the active provider. Connect it and run the connection test first.", "PROVIDER_NOT_CONFIGURED");
  }
  await setActiveProvider(env, org.id, providerKey, settings, state);
  const view = await paymentOverview(env, org.id);
  return ok({
    provider: view.active.provider,
    provider_label: view.active.provider_label,
    active_provider: view.active,
    providers: view.cards,
    payment_settings: view.settings_view,
    message: providerLabel(providerKey) + " is now your Active Payment Provider. Customers buying tickets for your events will be directed through it."
  }, cors);
}
/* POST /api/organizer/payment-providers/:provider/test and the legacy
   POST /api/organizer/payment-settings/test share this one implementation.
   Draft values may be sent so the organizer can test before saving; a test
   never stores the draft, only its outcome. */
async function providerTest(env, request, orgId, providerKey, body){
  const cors = corsFor(env, request);
  const settings = await loadPaymentSettings(env, orgId);
  const existing = await loadProviderRow(env, orgId, providerKey);
  const source = configSourceFor(settings, existing, providerKey);
  const stored = source.row ? await credentialsFromRow(env, providerKey, source.row) : null;
  let testCreds = stored;
  let isDraft = false;
  if(providerKey === "paystack" && body.secret_key){
    testCreds = { source: "draft", secret: vStr(body.secret_key, "secret key", { max: 400 }),
      public_key: vStr(body.public_key, "public key", { max: 200 }) || (source.row && source.row.public_key) || null };
    isDraft = true;
  } else if(providerKey === "pesapal" && body.consumer_key && body.consumer_secret){
    testCreds = { source: "draft", consumer_key: vStr(body.consumer_key, "consumer key", { max: 200 }),
      consumer_secret: vStr(body.consumer_secret, "consumer secret", { max: 400 }),
      ipn_id: (source.row && source.row.ipn_id) || null };
    isDraft = true;
  } else if(providerKey === "payhero" && body.api_username && body.password && body.channel_id){
    testCreds = { source: "draft",
      username: vStr(body.api_username, "api username", { max: 120 }),
      password: vStr(body.password, "api password", { max: 400 }),
      channel_id: vStr(body.channel_id, "channel id", { max: 40 }) };
    isDraft = true;
  }
  if(!testCreds){
    return ok({
      ok: false, tested: true, saved: !isDraft,
      provider: providerKey, provider_label: providerLabel(providerKey),
      message: "Add your " + providerLabel(providerKey) + " details before testing the connection."
    }, cors);
  }
  let result = { ok: false, message: "The connection test could not be completed. Please try again." };
  try {
    result = await providerFor(providerKey).test({ env: env, creds: testCreds, request: request, settings: settings });
  } catch(e){
    /* A provider-side error must never leak credentials or infrastructure
       detail: only our own safe sentence is returned. */
    result = { ok: false, message: (e instanceof ApiError) ? e.message : "The connection test failed. Please check your details." };
  }
  if(existing && !isDraft){
    const now = touch();
    const status = result.ok ? "connected" : "error";
    const message = result.ok ? null : String(result.message || "").slice(0, 300);
    await dbRun(env, "UPDATE organizer_payment_providers SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ? WHERE organizer_id = ? AND provider = ?",
      [status, now, message, now, orgId, providerKey]);
    if(settings && String(settings.provider) === providerKey){
      await dbRun(env, "UPDATE payment_settings SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ? WHERE organizer_id = ?",
        [status, now, message, now, orgId]);
    }
  }
  const view = await paymentOverview(env, orgId);
  const card = view.cards.filter(c => c.key === providerKey)[0] || null;
  return ok({
    ok: !!result.ok, tested: true, saved: !isDraft,
    provider: providerKey, provider_label: providerLabel(providerKey),
    message: result.message,
    provider_card: card,
    providers: view.cards,
    active_provider: view.active,
    payment_settings: view.settings_view
  }, cors);
}
/* POST /api/organizer/payment-providers/:provider/test */
async function routeProviderTest(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "payment_test", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const providerKey = vEnum(ctx.params.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  return providerTest(env, request, org.id, providerKey, await readJson(request));
}
/* The pre-PayHero test route: one provider in the body, everything else identical. */
async function routePaymentSettingsTest(ctx){
  const env = ctx.env, request = ctx.request;
  await guardRate(env, request, "payment_test", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const existing = await loadPaymentSettings(env, org.id);
  const body = await readJson(request);
  const providerKey = vEnum(body.provider, PAYMENT_PROVIDER_KEYS, "provider", providerKeyOf(existing));
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  return providerTest(env, request, org.id, providerKey, body);
}
/* The pre-PayHero PUT. "Connect this provider" has always also meant "make it
   the active one" on this route, so it maps onto saveProviderConfig + select. */
async function routePaymentSettingsPut(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  const { org } = await requireOrganizer(env, request);
  if(!org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const body = await readJson(request);
  if(body.clear === true || body.disconnect === true){
    for(const key of PAYMENT_PROVIDER_KEYS){
      await dbRun(env, "DELETE FROM organizer_payment_providers WHERE organizer_id = ? AND provider = ?", [org.id, key]);
    }
    await dbRun(env, "DELETE FROM payment_settings WHERE organizer_id = ?", [org.id]);
    const view = await paymentOverview(env, org.id);
    return ok({
      payment_settings: view.settings_view, providers: view.cards,
      active_provider: view.active, provider: view.active.provider,
      message: "Your saved payment providers have been removed."
    }, cors);
  }
  const existing = await loadPaymentSettings(env, org.id);
  const providerKey = vEnum(body.provider, PAYMENT_PROVIDER_KEYS, "provider", providerKeyOf(existing));
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  const row = await loadProviderRow(env, org.id, providerKey);
  await saveProviderConfig(env, org.id, providerKey, body, row);
  const settings = await loadPaymentSettings(env, org.id);
  const state = await providerState(env, settings, providerKey, await loadProviderRow(env, org.id, providerKey));
  if(state.configured && state.enabled && state.status !== "error"){
    await setActiveProvider(env, org.id, providerKey, settings, state);
  }
  const view = await paymentOverview(env, org.id);
  return ok({
    payment_settings: view.settings_view,
    providers: view.cards,
    active_provider: view.active,
    provider: view.active.provider,
    provider_label: view.active.provider_label,
    message: providerLabel(providerKey) + " settings saved. Run a connection test to confirm they work."
  }, cors);
}
/* ============================================================================
   PLATFORM OWNER PAYMENT SETTINGS  (owner payment mode)
   ----------------------------------------------------------------------------
   The owner connects the platform's own merchant accounts here, exactly the way
   an organizer connects theirs, but stored in platform_payment_providers (one
   row per provider, no organizer_id). Organizers whose event is in owner payment
   mode are then sold through the owner's active provider.
     GET    /api/owner/payment-providers             all three + their state
     POST   /api/owner/payment-providers/:provider   connect / update one
     DELETE /api/owner/payment-providers/:provider   disconnect that one
     POST   /api/owner/payment-providers/:provider/test
     POST   /api/owner/payment-provider/select       set the active owner provider
   Secrets are AES-GCM encrypted and never returned: only "has_..." indicators
   come back, exactly like the organizer store.
   ========================================================================== */
async function platformProviderState(env, providerKey, row){
  const storedRow = row || null;
  const creds = await credentialsForRow(env, providerKey, storedRow, null);
  const ownKeys = !!(storedRow && rowConfigured(providerKey, storedRow));
  const partial = rowPartial(providerKey, storedRow);
  let status = "not_connected";
  if(creds && ownKeys){
    const failed = String((storedRow && storedRow.status) || "") === "error";
    status = failed ? "error" : "connected";
  } else if(creds){
    status = "connected";
  } else if(partial){
    status = "configuration_required";
  }
  return {
    status: status,
    label: CONNECTION_LABELS[status],
    configured: status === "connected",
    credentials_source: creds ? creds.source : null,
    owner_account: !!(creds && creds.owner),
    enabled: storedRow ? Number(storedRow.enabled) !== 0 : true,
    last_tested_at: storedRow ? storedRow.last_tested_at : null,
    last_error: storedRow ? storedRow.last_error : null,
    fields: providerFields(storedRow),
    has_own_credentials: ownKeys,
    credentials_hint: credsAddress(creds, providerKey)
  };
}
async function platformProviderCard(env, providerKey, row){
  const state = await platformProviderState(env, providerKey, row);
  const provider = PROVIDERS[providerKey] || null;
  const capabilities = (provider && provider.capabilities) || {};
  return Object.assign({
    key: providerKey,
    label: providerLabel(providerKey),
    logo_mark: PROVIDER_BRAND[providerKey].mark,
    logo_color: PROVIDER_BRAND[providerKey].color,
    methods: PROVIDER_METHODS[providerKey],
    required_fields: PROVIDER_FIELDS[providerKey].slice(),
    test_supported: typeof (provider && provider.test) === "function",
    checkout_mode: capabilities.stk_push ? "stk_push" : "redirect",
    refund_supported: !!capabilities.refunds,
    platform_credentials: true
  }, state, {
    available: state.configured && state.enabled && state.status !== "error"
  });
}
async function platformPaymentOverview(env){
  const rows = await loadPlatformProviderRows(env);
  const activeKey = await ownerActiveProviderKey(env);
  const cards = [];
  for(const key of PAYMENT_PROVIDER_KEYS) cards.push(await platformProviderCard(env, key, rows[key] || null));
  const activeCard = cards.filter(c => c.key === activeKey)[0] || null;
  const active = {
    provider: activeKey,
    provider_label: providerLabel(activeKey),
    connected: !!(activeCard && activeCard.configured),
    credentials_source: activeCard ? activeCard.credentials_source : null,
    owner_account: true,
    available_providers: PAYMENT_PROVIDER_KEYS.filter(k => {
      const c = cards.filter(x => x.key === k)[0];
      return !!(c && c.available);
    })
  };
  return { cards: cards, active: active, active_card: activeCard, enabled: await ownerPaymentsEnabled(env) };
}

/* Writes one owner provider row. Mirrors saveProviderConfig but into the platform
   table; a blank secret keeps the stored ciphertext. */
async function savePlatformProviderConfig(env, providerKey, body, existingRow){
  const row = existingRow || {};
  const now = touch();
  const next = {
    public_key: row.public_key || null,
    consumer_key: row.consumer_key || null,
    api_username: row.api_username || null,
    channel_id: (row.channel_id === undefined || row.channel_id === null) ? null : String(row.channel_id),
    ipn_id: row.ipn_id || null,
    secret_key_encrypted: row.secret_key_encrypted || null,
    consumer_secret_encrypted: row.consumer_secret_encrypted || null,
    password_encrypted: row.password_encrypted || null,
    status: CONNECTION_STATUSES.indexOf(String(row.status)) > -1 ? String(row.status) : "not_connected",
    last_tested_at: row.last_tested_at || null,
    last_error: row.last_error || null,
    enabled: (row.enabled === undefined || row.enabled === null) ? 1 : Number(row.enabled)
  };
  const truthy = v => v === true || v === 1 || v === "1" || v === "true";
  if(body.enabled !== undefined) next.enabled = truthy(body.enabled) ? 1 : 0;
  if(truthy(body.reset)){ next.status = "not_connected"; next.last_error = null; next.last_tested_at = null; }
  if(providerKey === "paystack"){
    const publicKey = vStr(body.public_key, "public key", { max: 200 });
    const secretKey = vStr(body.secret_key, "secret key", { max: 400 });
    if(publicKey) next.public_key = publicKey;
    if(secretKey) next.secret_key_encrypted = await encryptSecret(env, secretKey);
  } else if(providerKey === "pesapal"){
    const consumerKey = vStr(body.consumer_key, "consumer key", { max: 200 });
    const consumerSecret = vStr(body.consumer_secret, "consumer secret", { max: 400 });
    if(consumerKey) next.consumer_key = consumerKey;
    if(consumerSecret) next.consumer_secret_encrypted = await encryptSecret(env, consumerSecret);
  } else if(providerKey === "payhero"){
    const apiUsername = vStr(body.api_username, "api username", { max: 120 });
    const password = vStr(body.password, "api password", { max: 400 });
    const channelId = vStr(body.channel_id, "channel id", { max: 40 });
    if(apiUsername) next.api_username = apiUsername;
    if(password) next.password_encrypted = await encryptSecret(env, password);
    if(channelId) next.channel_id = channelId;
  }
  if(next.channel_id !== null) next.channel_id = String(next.channel_id).replace(/[^0-9]/g, "") || String(next.channel_id);
  const complete = rowConfigured(providerKey, next);
  const touched = !!(body.public_key || body.secret_key || body.consumer_key || body.consumer_secret
    || body.api_username || body.password || body.channel_id);
  if(touched) next.last_error = null;
  if(!complete) next.status = rowPartial(providerKey, next) ? "configuration_required" : "not_connected";
  else if(touched || next.status === "not_connected" || next.status === "configuration_required") next.status = "connected";
  if(row.id){
    await dbRun(env,
      "UPDATE platform_payment_providers SET status = ?, enabled = ?, public_key = ?, consumer_key = ?, ipn_id = ?, api_username = ?, channel_id = ?, secret_key_encrypted = ?, consumer_secret_encrypted = ?, password_encrypted = ?, last_tested_at = ?, last_error = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ?",
      [next.status, next.enabled, next.public_key, next.consumer_key, next.ipn_id, next.api_username, next.channel_id,
       next.secret_key_encrypted, next.consumer_secret_encrypted, next.password_encrypted,
       next.last_tested_at, next.last_error, now, now, row.id]);
  } else {
    await dbRun(env,
      "INSERT INTO platform_payment_providers (provider, status, enabled, public_key, consumer_key, ipn_id, api_username, channel_id, secret_key_encrypted, consumer_secret_encrypted, password_encrypted, last_tested_at, last_error, connected_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [providerKey, next.status, next.enabled, next.public_key, next.consumer_key, next.ipn_id,
       next.api_username, next.channel_id, next.secret_key_encrypted, next.consumer_secret_encrypted,
       next.password_encrypted, next.last_tested_at, next.last_error,
       next.status === "connected" ? now : null, now]);
  }
  return loadPlatformProviderRow(env, providerKey);
}

async function routeOwnerPaymentProvidersGet(ctx){
  const env = ctx.env, request = ctx.request;
  await requireOwner(env, request);
  const view = await platformPaymentOverview(env);
  return ok({
    provider: view.active.provider,
    provider_label: view.active.provider_label,
    providers: view.cards,
    payment_providers: view.cards,
    active_provider: view.active,
    owner_payment_enabled: view.enabled,
    connected: view.active.connected
  }, corsFor(env, request));
}
async function routeOwnerProviderPut(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  await requireOwner(env, request);
  const providerKey = vEnum(ctx.params.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  const body = await readJson(request);
  const existing = await loadPlatformProviderRow(env, providerKey);
  await savePlatformProviderConfig(env, providerKey, body, existing);
  const view = await platformPaymentOverview(env);
  const card = view.cards.filter(c => c.key === providerKey)[0] || null;
  return ok({
    saved: true,
    provider: providerKey,
    provider_label: providerLabel(providerKey),
    provider_card: card,
    providers: view.cards,
    active_provider: view.active,
    owner_payment_enabled: view.enabled,
    message: providerLabel(providerKey) + " owner account saved. Run a connection test to confirm it works."
  }, cors);
}
async function routeOwnerProviderDelete(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  await requireOwner(env, request);
  const providerKey = vEnum(ctx.params.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  await dbRun(env, "DELETE FROM platform_payment_providers WHERE provider = ?", [providerKey]);
  const view = await platformPaymentOverview(env);
  return ok({
    disconnected: true,
    provider: providerKey,
    provider_label: providerLabel(providerKey),
    providers: view.cards,
    active_provider: view.active,
    owner_payment_enabled: view.enabled,
    message: providerLabel(providerKey) + " owner account has been disconnected. Past orders and tickets are unchanged."
  }, cors);
}

async function routeOwnerProviderTest(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_test", {});
  await requireOwner(env, request);
  const providerKey = vEnum(ctx.params.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider.", "VALIDATION");
  const body = await readJson(request);
  const existing = await loadPlatformProviderRow(env, providerKey);
  const stored = existing ? await credentialsFromRow(env, providerKey, existing) : null;
  let testCreds = stored;
  let isDraft = false;
  if(providerKey === "paystack" && body.secret_key){
    testCreds = { source: "draft", secret: vStr(body.secret_key, "secret key", { max: 400 }),
      public_key: vStr(body.public_key, "public key", { max: 200 }) || (existing && existing.public_key) || null };
    isDraft = true;
  } else if(providerKey === "pesapal" && body.consumer_key && body.consumer_secret){
    testCreds = { source: "draft", consumer_key: vStr(body.consumer_key, "consumer key", { max: 200 }),
      consumer_secret: vStr(body.consumer_secret, "consumer secret", { max: 400 }),
      ipn_id: (existing && existing.ipn_id) || null };
    isDraft = true;
  } else if(providerKey === "payhero" && body.api_username && body.password && body.channel_id){
    testCreds = { source: "draft", username: vStr(body.api_username, "api username", { max: 120 }),
      password: vStr(body.password, "api password", { max: 400 }),
      channel_id: vStr(body.channel_id, "channel id", { max: 40 }) };
    isDraft = true;
  }
  if(!testCreds){
    return ok({
      ok: false, tested: true, saved: !isDraft,
      provider: providerKey, provider_label: providerLabel(providerKey),
      message: "Add your " + providerLabel(providerKey) + " owner details before testing the connection."
    }, cors);
  }
  let result = { ok: false, message: "The connection test could not be completed." };
  try {
    result = await providerFor(providerKey).test({ env: env, creds: testCreds, request: request, settings: null });
  } catch(e){
    result = { ok: false, message: (e instanceof ApiError) ? e.message : "The connection test failed. Please check the details." };
  }
  if(existing && !isDraft){
    const now = touch();
    const status = result.ok ? "connected" : "error";
    const message = result.ok ? null : String(result.message || "").slice(0, 300);
    await dbRun(env, "UPDATE platform_payment_providers SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ? WHERE provider = ?",
      [status, now, message, now, providerKey]);
  }
  const view = await platformPaymentOverview(env);
  const card = view.cards.filter(c => c.key === providerKey)[0] || null;
  return ok({
    ok: !!result.ok, tested: true, saved: !isDraft,
    provider: providerKey, provider_label: providerLabel(providerKey),
    message: result.message,
    provider_card: card,
    providers: view.cards,
    active_provider: view.active
  }, cors);
}
async function routeOwnerProviderSelect(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await guardRate(env, request, "payment_settings", {});
  await requireOwner(env, request);
  const body = await readJson(request);
  const providerKey = vEnum(body.provider, PAYMENT_PROVIDER_KEYS, "provider", "");
  if(!providerKey) throw err(422, "Choose a payment provider to make active.", "VALIDATION");
  const row = await loadPlatformProviderRow(env, providerKey);
  const state = await platformProviderState(env, providerKey, row);
  if(!state.configured || !state.enabled || state.status === "error"){
    throw err(422, providerLabel(providerKey) + " is not connected yet, so it cannot be the owner's active provider. Connect it and run the connection test first.", "PROVIDER_NOT_CONFIGURED");
  }
  await setAppSetting(env, "owner_payment_active_provider", providerKey);
  const view = await platformPaymentOverview(env);
  return ok({
    provider: providerKey,
    provider_label: providerLabel(providerKey),
    active_provider: view.active,
    providers: view.cards,
    owner_payment_enabled: view.enabled,
    message: providerLabel(providerKey) + " is now the platform's active payment provider. Organizers in owner payment mode will be sold through it."
  }, cors);
}

/* ============================================================================
   ORGANIZER ORDERS + ATTENDEES
   Every query is scoped to the authenticated organizer's own records.
   ========================================================================== */
async function orderScope(env, session, url){
  const where = [], params = [];
  if(session.org){ where.push("o.organizer_id = ?"); params.push(session.org.id); }
  else { where.push("o.event_id IN (SELECT event_id FROM event_staff WHERE user_id = ?)"); params.push(session.user.id); }
  const eventId = url.searchParams.get("event_id");
  if(eventId){ where.push("o.event_id = ?"); params.push(vInt(eventId, "event", { min: 1, label: "Event id" })); }
  const status = vStr(url.searchParams.get("status"), "status", { max: 24 });
  if(status && status !== "all"){
    if(ORDER_STATUSES.indexOf(status) < 0) throw err(422, "Invalid order status filter.", "VALIDATION");
    where.push("o.status = ?"); params.push(status);
  }
  /* Money-trail filter: collected=owner | collected=organizer | collected=all.
     Lets the organizer isolate "money sitting in the owner account" per event. */
  const collected = vStr(url.searchParams.get("collected") || url.searchParams.get("collected_via"), "collected", { max: 20 });
  if(collected && collected !== "all"){
    const want = collected.toLowerCase();
    if(["owner", "organizer", "organiser", "unknown"].indexOf(want) < 0) throw err(422, "Invalid collected filter.", "VALIDATION");
    const mtHas = !!(await moneyTrailCols(env)).collected_via;
    if(!mtHas){
      /* Pre-0007: no collected_via column yet, so every order reads as
         "unknown" - only that view matches, owner/organizer match nothing. */
      if(want !== "unknown"){ where.push("1 = 0"); }
    }
    else if(want === "unknown"){ where.push("(o.collected_via IS NULL OR o.collected_via = 'unknown')"); }
    else if(want === "organizer" || want === "organiser"){ where.push("o.collected_via = 'organizer'"); }
    else { where.push("o.collected_via = 'owner'"); }
  }
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_email LIKE ? OR o.customer_phone LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like);
  }
  const from = vStr(url.searchParams.get("from"), "from", { max: 20 });
  if(from){ where.push("o.created_at >= ?"); params.push(from.slice(0, 10) + " 00:00:00"); }
  const to = vStr(url.searchParams.get("to"), "to", { max: 20 });
  if(to){ where.push("o.created_at <= ?"); params.push(to.slice(0, 10) + " 23:59:59"); }
  return { sql: " WHERE " + where.join(" AND "), params: params };
}
/* GET /api/organizer/orders */
async function routeOrganizerOrders(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  const session = await requireOrganizer(env, request);
  const scope = await orderScope(env, session, url);
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM orders o" + scope.sql, scope.params);
  const totals = await dbGet(env,
    "SELECT COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.total_amount ELSE 0 END),0) AS paid_amount, " +
    "COALESCE(SUM(CASE WHEN o.status = 'pending' THEN o.total_amount ELSE 0 END),0) AS pending_amount, " +
    "COALESCE(SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END),0) AS paid_count FROM orders o" + scope.sql, scope.params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env,
    "SELECT o.*, e.title AS event_title, e.event_date, " +
    "(SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS ticket_count " +
    "FROM orders o LEFT JOIN events e ON e.id = o.event_id" + scope.sql + " ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?",
    scope.params.concat([p.limit, p.offset]));
  const byOrder = await providersForOrders(env, rows);
  const trail = await moneyTrailForOrders(env, rows);
  /* Per-scope money split so the organizer sees, for this filter set, how much
     is sitting in the owner account vs their own - the mid-sale mode-flip view. */
  let split = null;
  try {
    const cols = await moneyTrailCols(env);
    if(cols.collected_via){
      const s = await dbGet(env,
        "SELECT COALESCE(SUM(CASE WHEN o.status='paid' AND o.collected_via='owner' THEN o.total_amount ELSE 0 END),0) AS owner_amount, " +
        "COALESCE(SUM(CASE WHEN o.status='paid' AND o.collected_via='owner' THEN 1 ELSE 0 END),0) AS owner_count, " +
        "COALESCE(SUM(CASE WHEN o.status='paid' AND (o.collected_via='organizer') THEN o.total_amount ELSE 0 END),0) AS organizer_amount, " +
        "COALESCE(SUM(CASE WHEN o.status='paid' AND (o.collected_via='organizer') THEN 1 ELSE 0 END),0) AS organizer_count " +
        "FROM orders o" + scope.sql, scope.params);
      split = { owner_amount: Number((s && s.owner_amount) || 0), owner_count: Number((s && s.owner_count) || 0),
        organizer_amount: Number((s && s.organizer_amount) || 0), organizer_count: Number((s && s.organizer_count) || 0) };
    }
  } catch(e){ split = null; }
  return ok({
    orders: rows.map(o => Object.assign({
      id: o.id,
      order_number: o.order_number,
      reference: o.order_number,
      event_id: o.event_id,
      event_title: o.event_title || null,
      event_date: o.event_date || null,
      customer_name: o.customer_name,
      name: o.customer_name,
      customer_email: o.customer_email,
      email: o.customer_email,
      customer_phone: o.customer_phone,
      phone: o.customer_phone,
      amount: Number(o.total_amount),
      total_amount: Number(o.total_amount),
      currency: o.currency,
      status: o.status,
      payment_status: o.status,
      ticket_count: Number(o.ticket_count || 0),
      paid_at: o.paid_at,
      created_at: o.created_at
    }, orderPaymentFields(byOrder, o.id), orderMoneyFields(trail, o.id))),
    summary: {
      count: total,
      paid_count: totals ? Number(totals.paid_count) : 0,
      paid_amount: totals ? Number(totals.paid_amount) : 0,
      pending_amount: totals ? Number(totals.pending_amount) : 0,
      owner_collected_amount: split ? split.owner_amount : 0,
      owner_collected_count: split ? split.owner_count : 0,
      organizer_collected_amount: split ? split.organizer_amount : 0,
      organizer_collected_count: split ? split.organizer_count : 0,
      money_split: split
    },
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
/* ------------------------------------------------- GET /api/organizer/orders/:id
   One order for the organizer view (the "Details" drawer on orders/index.html).
   Scoped with exactly the same orderScope() as the list route, so an organizer
   can only ever open an order that belongs to one of their own events - another
   organizer's order is simply not found, never merely forbidden. */
async function routeOrganizerOrder(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  await guardRate(env, request, "order_detail", {});
  const session = await requireOrganizer(env, request);
  const id = vInt(ctx.params.id, "order", { min: 1, label: "Order id" });
  const scope = await orderScope(env, session, url);
  const order = await dbGet(env,
    "SELECT o.*, e.title AS event_title, e.event_date, e.start_time, e.venue, e.location, " +
    "(SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS ticket_count " +
    "FROM orders o LEFT JOIN events e ON e.id = o.event_id" + scope.sql + " AND o.id = ?", scope.params.concat([id]));
  if(!order) throw err(404, "We could not find that order.", "NOT_FOUND");
  const items = await orderItemsFor(env, order.id);
  const payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  const rows = await dbAll(env, TICKET_SELECT + " WHERE t.order_id = ? ORDER BY t.id ASC", [order.id]);
  const tickets = rows.map(t => ticketPayload(t, { qr_image_url: qrUrlFor(request, t.ticket_number) }));
  const payload = orderPayload(order, items, payment, tickets);
  payload.event_title = order.event_title || null;
  payload.event_date = order.event_date || null;
  payload.start_time = order.start_time || null;
  payload.venue = order.venue || null;
  payload.location = order.location || null;
  payload.ticket_count = Number(order.ticket_count || tickets.length || 0);
  Object.assign(payload, orderMoneyFields(await moneyTrailForOrders(env, [order]), order.id));
  return ok(Object.assign({ order: payload }, payload), cors);
}
/* Shared attendee filtering, always scoped to the caller's own events. */
async function attendeeScope(ctx){
  const env = ctx.env, url = ctx.url;
  const session = await requireOrganizer(env, ctx.request);
  const where = [], params = [];
  if(session.org){ where.push("e.organizer_id = ?"); params.push(session.org.id); }
  else { where.push("t.event_id IN (SELECT event_id FROM event_staff WHERE user_id = ?)"); params.push(session.user.id); }
  const eventId = url.searchParams.get("event_id");
  if(eventId){ where.push("t.event_id = ?"); params.push(vInt(eventId, "event", { min: 1, label: "Event id" })); }
  const typeId = url.searchParams.get("ticket_type_id");
  if(typeId){ where.push("t.ticket_type_id = ?"); params.push(vInt(typeId, "ticket type", { min: 1, label: "Ticket type id" })); }
  const checkIn = vStr(url.searchParams.get("check_in"), "check in", { max: 20 });
  if(checkIn === "checked" || checkIn === "checked_in" || checkIn === "yes") where.push("t.checked_in = 1");
  else if(checkIn === "not_checked" || checkIn === "no") where.push("t.checked_in = 0");
  const payment = vStr(url.searchParams.get("payment_status"), "payment status", { max: 20 });
  if(payment && payment !== "all"){
    if(ORDER_STATUSES.indexOf(payment) < 0) throw err(422, "Invalid payment status filter.", "VALIDATION");
    where.push("o.status = ?"); params.push(payment);
  }
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(t.attendee_name LIKE ? OR t.attendee_email LIKE ? OR t.attendee_phone LIKE ? OR t.ticket_number LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like);
  }
  return { whereSql: " WHERE " + where.join(" AND "), params: params };
}
const ATTENDEE_SELECT = "SELECT t.id, t.ticket_number, t.attendee_name, t.attendee_email, t.attendee_phone, t.status AS ticket_status, " +
  "t.checked_in, t.checked_in_at, t.ticket_type_id, t.event_id, t.created_at, tt.name AS ticket_type_name, " +
  "e.title AS event_title, e.event_date, o.order_number, o.status AS order_status, o.customer_name, o.customer_email, o.customer_phone " +
  "FROM tickets t LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id LEFT JOIN events e ON e.id = t.event_id LEFT JOIN orders o ON o.id = t.order_id";
function attendeePayload(a){
  return {
    id: a.id,
    ticket_number: a.ticket_number,
    number: a.ticket_number,
    attendee_name: a.attendee_name,
    attendee: a.attendee_name,
    name: a.attendee_name,
    attendee_email: a.attendee_email,
    email: a.attendee_email,
    attendee_phone: a.attendee_phone,
    phone: a.attendee_phone,
    ticket_type_id: a.ticket_type_id,
    ticket_type_name: a.ticket_type_name || null,
    event_id: a.event_id,
    event_title: a.event_title || null,
    event_date: a.event_date || null,
    order_number: a.order_number || null,
    customer_name: a.customer_name || null,
    customer_email: a.customer_email || null,
    customer_phone: a.customer_phone || null,
    status: a.order_status || "pending",
    payment_status: a.order_status || "pending",
    ticket_status: a.ticket_status,
    checked_in: !!a.checked_in,
    checked_in_at: a.checked_in_at,
    check_in_status: a.checked_in ? "checked_in" : "not_checked",
    created_at: a.created_at
  };
}
/* GET /api/organizer/attendees */
async function routeOrganizerAttendees(ctx){
  const env = ctx.env, url = ctx.url;
  const scope = await attendeeScope(ctx);
  const counted = await dbGet(env,
    "SELECT COUNT(*) AS n FROM tickets t LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN events e ON e.id = t.event_id" + scope.whereSql, scope.params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env, ATTENDEE_SELECT + scope.whereSql + " ORDER BY t.id DESC LIMIT ? OFFSET ?", scope.params.concat([p.limit, p.offset]));
  return ok({
    attendees: rows.map(attendeePayload),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, corsFor(env, ctx.request));
}
/* GET /api/organizer/attendees.csv - server-generated export. */
async function routeOrganizerAttendeesCsv(ctx){
  const env = ctx.env;
  const scope = await attendeeScope(ctx);
  const rows = (await dbAll(env, ATTENDEE_SELECT + scope.whereSql + " ORDER BY t.id DESC LIMIT 5000", scope.params)).map(attendeePayload);
  const header = ["Ticket number", "Attendee", "Email", "Phone", "Ticket type", "Event", "Order", "Payment", "Checked in", "Checked in at"];
  const lines = [header.join(",")];
  for(const a of rows){
    lines.push([
      csvCell(a.ticket_number), csvCell(a.attendee_name), csvCell(a.attendee_email), csvCell(a.attendee_phone),
      csvCell(a.ticket_type_name), csvCell(a.event_title), csvCell(a.order_number), csvCell(a.payment_status),
      a.checked_in ? "Yes" : "No", csvCell(a.checked_in_at || "")
    ].join(","));
  }
  return new Response("\uFEFF" + lines.join("\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"tickethub-attendees.csv\"",
      "Cache-Control": "no-store"
    }
  });
}
function csvCell(value){
  const s = String(value == null ? "" : value).replace(/"/g, "\"\"");
  return /[",\r\n]/.test(s) ? ("\"" + s + "\"") : s;
}

/* ============================================================================
   OWNER (PLATFORM ADMIN) API
   Authorisation comes from users.role in D1 only - never from the client.
   ========================================================================== */
const OWNER_SETTING_KEYS = ["platform_name", "brand_line", "support_email", "support_phone", "platform_fee_percent",
  "default_provider", "organizer_signups_open", "maintenance_message", "public_base_url", "terms_url", "privacy_url",
  /* owner payment mode switch */
  "owner_payment_enabled", "owner_payment_active_provider",
  /* email branding + transport switches, read by emails.js through app_settings */
  "email_from_name", "email_from_email", "email_reply_to", "email_enabled"];
const BOOLEAN_SETTING_KEYS = ["organizer_signups_open", "email_enabled", "owner_payment_enabled"];
async function ownerSettings(env){
  const rows = await dbAll(env, "SELECT key, value FROM app_settings", []);
  const out = { platform_name: "Prince Alex TicketHub", brand_line: "Powered by Prince Alex Digital",
    support_email: "", support_phone: "",
    platform_fee_percent: 0, default_provider: "paystack", organizer_signups_open: true,
    owner_payment_enabled: true, owner_payment_active_provider: "paystack",
    email_from_name: "", email_from_email: "", email_reply_to: "", email_enabled: true };
  for(const r of rows){
    if(OWNER_SETTING_KEYS.indexOf(r.key) < 0) continue;
    if(r.key === "platform_fee_percent") out[r.key] = Number(r.value) || 0;
    else if(BOOLEAN_SETTING_KEYS.indexOf(r.key) > -1) out[r.key] = (String(r.value) === "true" || String(r.value) === "1");
    else out[r.key] = r.value;
  }
  return out;
}
/* GET /api/owner/dashboard */
async function routeOwnerDashboard(ctx){
  const env = ctx.env, request = ctx.request;
  await requireOwner(env, request);
  const orgs = await dbGet(env, "SELECT COUNT(*) AS n FROM organizers", []);
  const events = await dbGet(env, "SELECT COUNT(*) AS n FROM events", []);
  const active = await dbGet(env, "SELECT COUNT(*) AS n FROM events WHERE status = 'active'", []);
  const sold = await dbGet(env, "SELECT COALESCE(SUM(oi.quantity),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'paid'", []);
  const gross = await dbGet(env, "SELECT COALESCE(SUM(total_amount),0) AS n FROM orders WHERE status = 'paid'", []);
  const pending = await dbGet(env, "SELECT COALESCE(SUM(total_amount),0) AS n, COUNT(*) AS c FROM orders WHERE status = 'pending'", []);
  const issued = await dbGet(env, "SELECT COUNT(*) AS n FROM tickets", []);
  const checked = await dbGet(env, "SELECT COUNT(*) AS n FROM tickets WHERE checked_in = 1", []);
  const settings = await ownerSettings(env);
  const grossValue = gross ? Number(gross.n) : 0;
  /* Owner-account money: frozen snapshot when migration 0007 exists, so the
     Owner sees exactly what landed in THEIR active account per scope. */
  let ownerMoney = { owner_amount: 0, owner_count: 0, organizer_amount: 0, organizer_count: 0 };
  try {
    const cols = await moneyTrailCols(env);
    if(cols.collected_via){
      const m = await dbGet(env,
        "SELECT COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN total_amount ELSE 0 END),0) AS owner_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN 1 ELSE 0 END),0) AS owner_count, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN total_amount ELSE 0 END),0) AS organizer_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN 1 ELSE 0 END),0) AS organizer_count FROM orders", []);
      ownerMoney = { owner_amount: Number((m && m.owner_amount) || 0), owner_count: Number((m && m.owner_count) || 0),
        organizer_amount: Number((m && m.organizer_amount) || 0), organizer_count: Number((m && m.organizer_count) || 0) };
    }
  } catch(e){ /* pre-migration: zeros, dashboard still loads */ }
  const stats = {
    total_organizers: orgs ? Number(orgs.n) : 0,
    total_events: events ? Number(events.n) : 0,
    active_events: active ? Number(active.n) : 0,
    tickets_sold: sold ? Number(sold.n) : 0,
    tickets_issued: issued ? Number(issued.n) : 0,
    gross_sales: grossValue,
    gross_revenue: grossValue,
    platform_revenue: Math.round(grossValue * (Number(settings.platform_fee_percent) || 0) / 100),
    platform_fee_percent: Number(settings.platform_fee_percent) || 0,
    pending_payments: pending ? Number(pending.n) : 0,
    pending_orders: pending ? Number(pending.c) : 0,
    checked_in: checked ? Number(checked.n) : 0,
    owner_collected_amount: ownerMoney.owner_amount,
    owner_collected_count: ownerMoney.owner_count,
    organizer_collected_amount: ownerMoney.organizer_amount,
    organizer_collected_count: ownerMoney.organizer_count
  };
  const mtCols = await moneyTrailCols(env);
  const recentOrders = await dbAll(env,
    "SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.customer_phone, o.total_amount, o.currency, o.status, o.created_at, " +
    (mtCols.collected_via ? "o.collected_via, " : "") + (mtCols.payment_provider ? "o.payment_provider, " : "") + (mtCols.provider_label ? "o.provider_label, " : "") +
    "e.title AS event_title, og.business_name AS organizer_name FROM orders o LEFT JOIN events e ON e.id = o.event_id " +
    "LEFT JOIN organizers og ON og.id = o.organizer_id ORDER BY o.id DESC LIMIT 8", []);
  const recentOrgs = await dbAll(env,
    "SELECT og.id, og.business_name, og.business_email, og.business_phone, og.status, og.created_at, u.full_name, u.email, " +
    "(SELECT COUNT(*) FROM events e WHERE e.organizer_id = og.id) AS events_count " +
    "FROM organizers og LEFT JOIN users u ON u.id = og.user_id ORDER BY og.id DESC LIMIT 6", []);
  const recentEvents = await dbAll(env,
    "SELECT e.id, e.title, e.slug, e.status, e.event_date, e.venue, e.location, e.poster_url, og.business_name AS organizer_name " +
    "FROM events e LEFT JOIN organizers og ON og.id = e.organizer_id ORDER BY e.id DESC LIMIT 6", []);
  const recentTrail = await moneyTrailForOrders(env, recentOrders);
  return ok({
    stats: stats,
    summary: stats,
    settings: settings,
    recent_orders: recentOrders.map(o => Object.assign({}, o, { amount: Number(o.total_amount), total_amount: Number(o.total_amount) },
      orderMoneyFields(recentTrail, o.id))),
    recent_organizers: recentOrgs.map(o => Object.assign({}, o, { events_count: Number(o.events_count || 0) })),
    recent_events: recentEvents
  }, corsFor(env, request));
}
/* GET /api/owner/organizers  +  PUT /api/owner/organizers/:id */
async function routeOwnerOrganizers(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  await requireOwner(env, request);
  if(request.method === "PUT"){
    const id = vInt(ctx.params.id, "organizer", { min: 1, label: "Organizer id" });
    const body = await readJson(request);
    const requested = vEnum(body.status, ["active", "suspended", "rejected"], "status", "active");
    const stored = requested === "rejected" ? "suspended" : requested;
    const org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [id]);
    if(!org) throw err(404, "That organizer does not exist.", "NOT_FOUND");
    await dbRun(env, "UPDATE organizers SET status = ?, updated_at = ? WHERE id = ?", [stored, touch(), id]);
    if(stored === "suspended"){
      /* A suspended organizer must not keep selling: pause their live events. */
      await dbRun(env, "UPDATE events SET status = 'paused', updated_at = ? WHERE organizer_id = ? AND status = 'active'", [touch(), id]);
    }
    const freshOrg = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [id]);
    if(stored !== String(org.status)){
      await notifyOrganizerStatusEmail(env, freshOrg, stored, request, ctx.ctx,
        vStr(body.reason || body.message, "reason", { max: 300 }));
    }
    return ok({ organizer_id: id, status: stored, requested_status: requested, message: "Organizer " + stored + "." }, cors);
  }
  const where = [], params = [];
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(og.business_name LIKE ? OR og.business_email LIKE ? OR og.business_phone LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like, like);
  }
  const status = vStr(url.searchParams.get("status"), "status", { max: 20 });
  if(status && status !== "all"){ where.push("og.status = ?"); params.push(status); }
  const whereSql = where.length ? (" WHERE " + where.join(" AND ")) : "";
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM organizers og LEFT JOIN users u ON u.id = og.user_id" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env,
    "SELECT og.id, og.business_name, og.business_email, og.business_phone, og.logo_url, og.status, og.created_at, og.updated_at, " +
    "u.full_name, u.email AS user_email, u.phone, u.status AS user_status, " +
    "(SELECT oa.reference FROM organizer_agreements oa WHERE oa.organizer_id = og.id AND oa.status = 'accepted' ORDER BY oa.id DESC LIMIT 1) AS signed_agreement_reference, " +
    "(SELECT COUNT(*) FROM events e WHERE e.organizer_id = og.id) AS events_count, " +
    "(SELECT COUNT(*) FROM events e WHERE e.organizer_id = og.id AND e.status = 'active') AS active_events, " +
    "(SELECT COALESCE(SUM(o.total_amount),0) FROM orders o WHERE o.organizer_id = og.id AND o.status = 'paid') AS revenue " +
    "FROM organizers og LEFT JOIN users u ON u.id = og.user_id" + whereSql + " ORDER BY og.id DESC LIMIT ? OFFSET ?",
    params.concat([p.limit, p.offset]));
  return ok({
    organizers: rows.map(o => Object.assign({}, o, {
      email: o.business_email || o.user_email || null,
      phone: o.business_phone || o.phone || null,
      events_count: Number(o.events_count || 0),
      active_events: Number(o.active_events || 0),
      revenue: Number(o.revenue || 0)
    })),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
/* GET /api/owner/organizers/:id/agreement/document
   Owner-only access to the organizer's authoritative signed HTML copy. */
async function routeOwnerOrganizerAgreementDocument(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  const owner = await requireOwner(env, request);
  const organizerId = vInt(ctx.params.id, "organizer", { min: 1, label: "Organizer id" });
  const signature = await dbGet(env,
    "SELECT * FROM organizer_agreements WHERE organizer_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1",
    [organizerId]);
  if(!signature) throw err(404, "This organizer has no signed agreement to download.", "NO_SIGNED_AGREEMENT");
  const organizer = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [organizerId]);
  if(!organizer) throw err(404, "That organizer does not exist.", "NOT_FOUND");
  const user = signature.user_id ? await dbGet(env, "SELECT * FROM users WHERE id = ?", [signature.user_id]) : null;
  let html = null;
  if(signature.document_key && env.BUCKET && typeof env.BUCKET.get === "function"){
    try {
      const object = await env.BUCKET.get(signature.document_key);
      if(object) html = await object.text();
    } catch(e){ html = null; }
  }
  if(!html){
    const agreement = await agreementById(env, signature.agreement_id);
    const source = agreement || { version: signature.agreement_version, title: "Organizer Agreement",
      content: signature.content_snapshot, fee_config_json: signature.fee_snapshot_json, effective_date: null };
    html = agreementDocumentHtml({
      signature: signature, agreement: source, organizer: organizer, user: user || {},
      brand: await emailBrandFor(env), fee_view: agreementFeeView(source),
      content: String(signature.content_snapshot || ""), sha256: signature.document_sha256 || ""
    });
    try { await agreementStoreDocument(env, signature, html); } catch(e){ /* best effort */ }
  }
  await agreementAudit(env, request, {
    action: "document_downloaded", agreement_id: signature.agreement_id,
    agreement_version: signature.agreement_version, organizer_id: organizerId,
    actor_user_id: owner.user.id, actor_role: "owner", subject_user_id: signature.user_id,
    detail: { reference: signature.reference, downloaded_by_owner: true }
  });
  const reference = String(signature.reference || "document").replace(/[^A-Za-z0-9_-]/g, "");
  const headers = Object.assign({}, cors || {}, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"organizer-agreement-" + (reference || "document") + ".html\"",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store"
  });
  return new Response(html, { status: 200, headers: headers });
}
/* GET /api/owner/events  +  PUT /api/owner/events/:id */
async function routeOwnerEvents(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  const actor = await requireOwner(env, request);
  if(request.method === "PUT"){
    const id = vInt(ctx.params.id, "event", { min: 1, label: "Event id" });
    const body = await readJson(request);
    const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [id]);
    if(!ev) throw err(404, "That event does not exist.", "NOT_FOUND");
    /* AGREEMENT GATE (approval): this is THE path that publishes, and it checks
       the event's ORGANIZER - never the acting owner's own status. An unsigned
       organizer's event cannot be approved by anyone, including the platform
       owner: there is no administrative override. */
    let agreementGate = null;
    if(body.status !== undefined && String(body.status) === "active" && String(ev.status) !== "active"){
      agreementGate = await requireAgreementForPublish(env, request, ev.organizer_id,
        { source: "owner_approval", event_id: id, actor_user_id: actor.user.id, actor_role: "owner" });
    }
    const sets = [], params = [];
    if(body.status !== undefined){
      sets.push("status = ?");
      params.push(vEnum(body.status, EVENT_STATUSES, "status", ev.status));
    }
    if(body.is_featured !== undefined){
      sets.push("is_featured = ?");
      params.push((body.is_featured === true || body.is_featured === 1 || body.is_featured === "1" || body.is_featured === "true") ? 1 : 0);
    }
    if(!sets.length) throw err(422, "There is nothing to update.", "VALIDATION");
    /* Approving a submitted event: the owner is the reviewer, so this is the one
       path that may publish it. A submitted event with nothing to sell would go
       live empty, so the same ticket rule the organizer path enforces applies.
       The rule covers ANY move into "active" (pending approval, or a draft or
       paused event published straight away), never a no-op on a live event. */
    if(body.status !== undefined && String(body.status) === "active" && String(ev.status) !== "active"){
      const tt = await dbGet(env, "SELECT COUNT(*) AS n FROM ticket_types WHERE event_id = ? AND status = 'active'", [id]);
      if(!tt || Number(tt.n) === 0){
        throw err(409, "This event has no active ticket type yet, so it cannot go on sale. Send it back with a reason instead.", "NO_TICKETS");
      }
    }
    sets.push("updated_at = ?"); params.push(touch()); params.push(id);
    await dbRun(env, "UPDATE events SET " + sets.join(", ") + " WHERE id = ?", params);
    if(agreementGate) await stampEventAgreement(env, id, agreementGate);
    const row = await dbGet(env, "SELECT e.*, og.business_name AS organizer_name FROM events e LEFT JOIN organizers og ON og.id = e.organizer_id WHERE e.id = ?", [id]);
    if(body.status !== undefined && String(row.status) !== String(ev.status)){
      const note = vStr(body.reason || body.message, "reason", { max: 300 });
      await notifyEventStatusEmail(env, row, ev.status, row.status, request, ctx.ctx,
        note || (row.status === "cancelled" ? "The organizer cancelled this event." : "Approved by the platform team."));
      /* Sending a submission back is a decision the organizer must hear about,
         with the reason, or the event would silently stall in their list. */
      if(String(row.status) === "draft" && String(ev.status) === "pending"){
        await notifyEventChangesRequestedEmail(env, row, request, ctx.ctx, note);
      }
    }
    return ok({
      event: Object.assign({}, row, { is_featured: !!row.is_featured }),
      message: String(row.status) === "active" && String(ev.status) === "pending"
        ? "Event approved and published. The organizer has been emailed."
        : "Event updated."
    }, cors);
  }
  const where = [], params = [];
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(e.title LIKE ? OR e.slug LIKE ? OR e.venue LIKE ? OR e.location LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like);
  }
  const status = vStr(url.searchParams.get("status"), "status", { max: 20 });
  if(status && status !== "all"){
    if(EVENT_STATUSES.indexOf(status) < 0) throw err(422, "Invalid status filter.", "VALIDATION");
    where.push("e.status = ?"); params.push(status);
  }
  const featured = vStr(url.searchParams.get("featured"), "featured", { max: 10 });
  if(featured === "true" || featured === "1") where.push("e.is_featured = 1");
  else if(featured === "false" || featured === "0") where.push("e.is_featured = 0");
  const when = vStr(url.searchParams.get("when"), "when", { max: 20 });
  /* Kenyan calendar day, so "upcoming" means tonight's show too (see keToday). */
  const whenToday = keToday();
  if(when === "upcoming"){ where.push("e.event_date >= ?"); params.push(whenToday); }
  else if(when === "past"){ where.push("e.event_date < ?"); params.push(whenToday); }
  const whereSql = where.length ? (" WHERE " + where.join(" AND ")) : "";
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM events e" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env,
    "SELECT e.*, og.business_name AS organizer_name, og.status AS organizer_status, " +
    "(SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.event_id = e.id AND o.status = 'paid') AS tickets_sold, " +
    "(SELECT COALESCE(SUM(o.total_amount),0) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid') AS revenue, " +
    "(SELECT MIN(tt.price) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'active') AS starting_price " +
    "FROM events e LEFT JOIN organizers og ON og.id = e.organizer_id" + whereSql + " ORDER BY e.id DESC LIMIT ? OFFSET ?",
    params.concat([p.limit, p.offset]));
  return ok({
    events: rows.map(organizerEventPayload),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
/* GET /api/owner/orders */
async function routeOwnerOrders(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  await requireOwner(env, request);
  const where = [], params = [];
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_email LIKE ? OR o.customer_phone LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like, like);
  }
  const eventParam = vStr(url.searchParams.get("event"), "event", { max: 60 });
  if(eventParam){
    if(/^\d+$/.test(eventParam)){ where.push("o.event_id = ?"); params.push(Number(eventParam)); }
    else { where.push("e.title LIKE ?"); params.push("%" + eventParam + "%"); }
  }
  const status = vStr(url.searchParams.get("status"), "status", { max: 20 });
  if(status && status !== "all"){
    if(ORDER_STATUSES.indexOf(status) < 0) throw err(422, "Invalid order status filter.", "VALIDATION");
    where.push("o.status = ?"); params.push(status);
  }
  const from = vStr(url.searchParams.get("from"), "from", { max: 20 });
  if(from){ where.push("o.created_at >= ?"); params.push(from.slice(0, 10) + " 00:00:00"); }
  const to = vStr(url.searchParams.get("to"), "to", { max: 20 });
  if(to){ where.push("o.created_at <= ?"); params.push(to.slice(0, 10) + " 23:59:59"); }
  /* Money-trail filter: the Owner's core view is "money in MY active account".
     collected=owner isolates it; per-event + summary below show the split. */
  const collected = vStr(url.searchParams.get("collected") || url.searchParams.get("collected_via"), "collected", { max: 20 });
  if(collected && collected !== "all"){
    const want = collected.toLowerCase();
    if(["owner", "organizer", "organiser", "unknown"].indexOf(want) < 0) throw err(422, "Invalid collected filter.", "VALIDATION");
    const mtHas = !!(await moneyTrailCols(env)).collected_via;
    if(!mtHas){
      /* Pre-0007: no collected_via column yet, so every order reads as
         "unknown" - only that view matches, owner/organizer match nothing. */
      if(want !== "unknown"){ where.push("1 = 0"); }
    }
    else if(want === "unknown"){ where.push("(o.collected_via IS NULL OR o.collected_via = 'unknown')"); }
    else if(want === "organizer" || want === "organiser"){ where.push("o.collected_via = 'organizer'"); }
    else { where.push("o.collected_via = 'owner'"); }
  }
  const whereSql = where.length ? (" WHERE " + where.join(" AND ")) : "";
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM orders o LEFT JOIN events e ON e.id = o.event_id" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const mtCols = await moneyTrailCols(env);
  const sums = await dbGet(env,
    "SELECT COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.total_amount ELSE 0 END),0) AS paid_amount, " +
    "COALESCE(SUM(CASE WHEN o.status = 'pending' THEN o.total_amount ELSE 0 END),0) AS pending_amount, " +
    (mtCols.collected_via ? "COALESCE(SUM(CASE WHEN o.status = 'paid' AND o.collected_via = 'owner' THEN o.total_amount ELSE 0 END),0) AS owner_amount, " : "0 AS owner_amount, ") +
    (mtCols.collected_via ? "COALESCE(SUM(CASE WHEN o.status = 'paid' AND o.collected_via = 'owner' THEN 1 ELSE 0 END),0) AS owner_count, " : "0 AS owner_count, ") +
    (mtCols.collected_via ? "COALESCE(SUM(CASE WHEN o.status = 'paid' AND o.collected_via = 'organizer' THEN o.total_amount ELSE 0 END),0) AS organizer_amount, " : "0 AS organizer_amount, ") +
    (mtCols.collected_via ? "COALESCE(SUM(CASE WHEN o.status = 'paid' AND o.collected_via = 'organizer' THEN 1 ELSE 0 END),0) AS organizer_count " : "0 AS organizer_count ") +
    "FROM orders o LEFT JOIN events e ON e.id = o.event_id" + whereSql, params);
  const p = paginate(url);
  const rows = await dbAll(env,
    "SELECT o.*, e.title AS event_title, e.event_date, og.business_name AS organizer_name, " +
    "(SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS ticket_count " +
    "FROM orders o LEFT JOIN events e ON e.id = o.event_id LEFT JOIN organizers og ON og.id = o.organizer_id" +
    whereSql + " ORDER BY o.id DESC LIMIT ? OFFSET ?", params.concat([p.limit, p.offset]));
  const byOrder = await providersForOrders(env, rows);
  const trail = await moneyTrailForOrders(env, rows);
  /* Failed-order counts for the owner reconcile banner: only failed/pending
     orders WITH a gateway transaction can be retried (server re-verifies). */
  let failedCount = 0;
  try {
    const f = await dbGet(env,
      "SELECT COUNT(*) AS n FROM orders o LEFT JOIN events e ON e.id = o.event_id" +
      whereSql + (whereSql ? " AND " : " WHERE ") + "o.status IN ('failed','pending') AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)",
      params);
    failedCount = f ? Number(f.n) : 0;
  } catch(e){ failedCount = 0; }
  return ok({
    orders: rows.map(o => {
      const base = {
      id: o.id, order_number: o.order_number, reference: o.order_number,
      event_id: o.event_id, event_title: o.event_title || null, event_date: o.event_date || null,
      organizer_name: o.organizer_name || null, organizer_id: o.organizer_id,
      customer_name: o.customer_name, customer_email: o.customer_email, customer_phone: o.customer_phone,
      email: o.customer_email, phone: o.customer_phone,
      amount: Number(o.total_amount), total_amount: Number(o.total_amount), currency: o.currency,
      status: o.status, payment_status: o.status, ticket_count: Number(o.ticket_count || 0),
      paid_at: o.paid_at, created_at: o.created_at
      };
      const merged = Object.assign(base, orderPaymentFields(byOrder, o.id), orderMoneyFields(trail, o.id));
      /* Retry visibility: a failed/pending order with a gateway transaction can
         be reconciled (server re-verifies with the provider). Paid orders never
         show retry; cancelled/refunded orders are terminal. */
      merged.reconcile_available = ownerReconcileFlag(o.status, byOrder[o.id] || null);
      return merged;
    }),
    reconcilable_count: failedCount,
    failed_count: failedCount,
    summary: {
      count: total,
      paid_amount: sums ? Number(sums.paid_amount) : 0,
      pending_amount: sums ? Number(sums.pending_amount) : 0,
      owner_collected_amount: sums ? Number(sums.owner_amount || 0) : 0,
      owner_collected_count: sums ? Number(sums.owner_count || 0) : 0,
      organizer_collected_amount: sums ? Number(sums.organizer_amount || 0) : 0,
      organizer_collected_count: sums ? Number(sums.organizer_count || 0) : 0
    },
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
/* POST /api/owner/orders/:id/reconcile - verify-only retry for a failed or
   stuck-pending payment. Re-queries the provider server-to-server with the
   SAME credentials the transaction was created with (organizer's own keys
   first, owner-mode account when the order was collected there, platform
   fallback for legacy rows) and settles ONLY on a confirmed success with a
   matching amount/currency/reference. Never forces paid, never charges. */
async function routeOwnerReconcile(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  const owner = await requireOwner(env, request);
  await guardRate(env, request, "owner_reconcile", { uid: (owner.user && owner.user.firebase_uid) || "" });
  const id = vInt(ctx.params.id, "order", { min: 1, label: "Order id" });
  const order = await dbGet(env,
    "SELECT o.*, e.title AS event_title, e.payment_mode AS event_payment_mode FROM orders o LEFT JOIN events e ON e.id = o.event_id WHERE o.id = ?", [id]);
  if(!order) throw err(404, "That order does not exist.", "NOT_FOUND");
  if(order.status === "paid") throw err(409, "That order is already paid.", "ALREADY_PAID");
  if(["cancelled", "refunded"].indexOf(order.status) > -1)
    throw err(409, "That order is " + order.status + " and cannot be reconciled.", "ORDER_TERMINAL");
  if(["failed", "pending"].indexOf(order.status) < 0)
    throw err(409, "Only failed or pending orders can be reconciled.", "BAD_ORDER_STATUS");
  let payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  if(!payment) throw err(409, "That order has no payment transaction to reconcile.", "NO_PAYMENT");
  if(payment.status === "success") throw err(409, "That payment already settled.", "ALREADY_SETTLED");
  /* Credentials follow the money trail: owner-collected orders verify with the
     platform owner's account, organizer-collected with the organizer's own
     keys, legacy shared-account rows via allowPlatform. Same provider only. */
  let creds = null;
  try {
    const ev = order.event_id ? await dbGet(env, "SELECT * FROM events WHERE id = ?", [order.event_id]) : null;
    const resolved = await resolveEffectiveProvider(env, { event: ev, organizer_id: order.organizer_id });
    if(resolved && resolved.configured && resolved.provider_key === payment.provider && resolved.creds) creds = resolved.creds;
  } catch(e){ creds = null; }
  if(!creds){
    const settings = await loadPaymentSettings(env, order.organizer_id);
    creds = await resolveCredentials(env, settings, payment.provider, { organizer_id: order.organizer_id, allowPlatform: true });
  }
  if(!creds) throw err(409, "No usable " + providerLabel(payment.provider) + " credentials for that transaction.", "PROVIDER_NOT_CONFIGURED");
  let result;
  try {
    result = await settlePayment(env, order, payment, providerFor(payment.provider), creds, payment.provider_ref, request, ctx.ctx);
  } catch(e){
    throw err(502, "The payment provider did not answer. Try again shortly.", "PROVIDER_UNREACHABLE");
  }
  const freshOrder = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [order.id]);
  payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [order.id]);
  const detail = ownerPaymentDetail(payment);
  if(result && result.settled){
    return ok({ reconciled: true, settled: true, order_status: freshOrder.status,
      message: "Payment confirmed with " + providerLabel(payment.provider) + " - order marked paid and tickets issued.",
      order: { id: freshOrder.id, order_number: freshOrder.order_number, status: freshOrder.status, paid_at: freshOrder.paid_at },
      payment: detail }, cors);
  }
  if(result && result.failed){
    return ok({ reconciled: true, settled: false, order_status: freshOrder.status,
      message: "The provider confirms this payment failed (" + (payment.failure_reason || "failed") + "). No tickets issued.",
      order: { id: freshOrder.id, order_number: freshOrder.order_number, status: freshOrder.status },
      payment: detail }, cors);
  }
  if(result && result.mismatch){
    return ok({ reconciled: true, settled: false, order_status: freshOrder.status,
      message: "The provider reported a payment that does not match this order (" + result.mismatch + " mismatch). Left as failed for review.",
      order: { id: freshOrder.id, order_number: freshOrder.order_number, status: freshOrder.status },
      payment: detail }, cors);
  }
  return ok({ reconciled: true, settled: false, order_status: freshOrder.status,
    message: "The payment is still pending with " + providerLabel(payment.provider) + ". Try again once the customer completes it.",
    order: { id: freshOrder.id, order_number: freshOrder.order_number, status: freshOrder.status },
    payment: detail }, cors);
}
/* GET /api/owner/events/:id/settlement - the Owner's money view for ONE event:
   paid totals split by owner-account vs organizer-account, from the frozen
   per-order snapshot, so a mid-sale payment_mode flip stays transparent. */
async function routeOwnerEventSettlement(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await requireOwner(env, request);
  const id = vInt(ctx.params.id, "event", { min: 1, label: "Event id" });
  const ev = await dbGet(env, "SELECT e.*, og.business_name AS organizer_name FROM events e LEFT JOIN organizers og ON og.id = e.organizer_id WHERE e.id = ?", [id]);
  if(!ev) throw err(404, "That event does not exist.", "NOT_FOUND");
  let split = { owner_amount: 0, owner_count: 0, organizer_amount: 0, organizer_count: 0, total_amount: 0, total_count: 0 };
  try {
    const cols = await moneyTrailCols(env);
    if(cols.collected_via){
      const s = await dbGet(env,
        "SELECT COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN total_amount ELSE 0 END),0) AS owner_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='owner' THEN 1 ELSE 0 END),0) AS owner_count, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN total_amount ELSE 0 END),0) AS organizer_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' AND collected_via='organizer' THEN 1 ELSE 0 END),0) AS organizer_count, " +
        "COALESCE(SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END),0) AS total_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS total_count FROM orders WHERE event_id = ?", [id]);
      split = { owner_amount: Number((s && s.owner_amount) || 0), owner_count: Number((s && s.owner_count) || 0),
        organizer_amount: Number((s && s.organizer_amount) || 0), organizer_count: Number((s && s.organizer_count) || 0),
        total_amount: Number((s && s.total_amount) || 0), total_count: Number((s && s.total_count) || 0) };
    } else {
      const s = await dbGet(env, "SELECT COALESCE(SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END),0) AS total_amount, " +
        "COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS total_count FROM orders WHERE event_id = ?", [id]);
      split = { owner_amount: 0, owner_count: 0, organizer_amount: Number((s && s.total_amount) || 0),
        organizer_count: Number((s && s.total_count) || 0), total_amount: Number((s && s.total_amount) || 0),
        total_count: Number((s && s.total_count) || 0) };
    }
  } catch(e){ /* totals stay zeroed, never a 500 */ }
  const activeProvider = await ownerActiveProviderKey(env);
  return ok({
    event: { id: ev.id, title: ev.title, slug: ev.slug, status: ev.status, event_date: ev.event_date,
      organizer_name: ev.organizer_name || null, organizer_id: ev.organizer_id,
      payment_mode: ev.payment_mode || null, payment_provider: ev.payment_provider || null,
      payment_provider_label: ev.payment_provider ? providerLabel(ev.payment_provider) : null },
    settlement: split,
    owner_collected_amount: split.owner_amount,
    owner_collected_count: split.owner_count,
    organizer_collected_amount: split.organizer_amount,
    organizer_collected_count: split.organizer_count,
    owner_active_provider: activeProvider,
    owner_active_provider_label: providerLabel(activeProvider)
  }, cors);
}
/* GET /api/owner/users */
async function routeOwnerUsers(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  await requireOwner(env, request);
  const where = [], params = [];
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like);
  }
  const role = vStr(url.searchParams.get("role"), "role", { max: 20 });
  if(role && role !== "all"){
    if(["owner", "organizer", "event_staff"].indexOf(role) < 0) throw err(422, "Invalid role filter.", "VALIDATION");
    where.push("u.role = ?"); params.push(role);
  }
  const whereSql = where.length ? (" WHERE " + where.join(" AND ")) : "";
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM users u" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env,
    "SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.created_at, u.updated_at, " +
    "(SELECT og.id FROM organizers og WHERE og.user_id = u.id) AS organizer_id, " +
    "(SELECT COUNT(*) FROM event_staff s WHERE s.user_id = u.id) AS assigned_events " +
    "FROM users u" + whereSql + " ORDER BY u.id DESC LIMIT ? OFFSET ?", params.concat([p.limit, p.offset]));
  return ok({
    users: rows.map(u => Object.assign({}, u, { assigned_events: Number(u.assigned_events || 0) })),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
/* GET /api/owner/settings  +  PUT /api/owner/settings */
async function routeOwnerSettings(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  await requireOwner(env, request);
  if(request.method === "PUT"){
    const body = await readJson(request);
    const updates = [];
    if(body.support_email !== undefined) updates.push(["support_email", vEmail(body.support_email, "support email", false) || ""]);
    if(body.support_phone !== undefined) updates.push(["support_phone", vStr(body.support_phone, "support phone", { max: 32 })]);
    if(body.platform_name !== undefined) updates.push(["platform_name", vStr(body.platform_name, "platform name", { max: 120 })]);
    if(body.maintenance_message !== undefined) updates.push(["maintenance_message", vStr(body.maintenance_message, "maintenance message", { max: 500 })]);
    if(body.public_base_url !== undefined) updates.push(["public_base_url", vStr(body.public_base_url, "public base url", { max: 200 })]);
    if(body.platform_fee_percent !== undefined){
      const fee = Number(body.platform_fee_percent);
      if(!Number.isFinite(fee) || fee < 0 || fee > 50) throw err(422, "Enter a platform fee between 0 and 50 percent.", "VALIDATION");
      updates.push(["platform_fee_percent", String(Math.round(fee * 100) / 100)]);
    }
    if(body.default_provider !== undefined){
      updates.push(["default_provider", vEnum(body.default_provider, PAYMENT_PROVIDER_KEYS, "default provider", "paystack")]);
    }
    if(body.organizer_signups_open !== undefined){
      const open = (body.organizer_signups_open === true || body.organizer_signups_open === "true" || body.organizer_signups_open === 1);
      updates.push(["organizer_signups_open", open ? "true" : "false"]);
    }
    if(body.owner_payment_enabled !== undefined){
      const on = (body.owner_payment_enabled === true || body.owner_payment_enabled === "true" || body.owner_payment_enabled === 1);
      updates.push(["owner_payment_enabled", on ? "true" : "false"]);
    }
    /* Email identity. The sender address must be a verified sender/domain in
       Brevo, otherwise the API rejects every message (recorded as failed). */
    if(body.brand_line !== undefined) updates.push(["brand_line", vStr(body.brand_line, "brand line", { max: 120 })]);
    if(body.email_from_name !== undefined) updates.push(["email_from_name", vStr(body.email_from_name, "email from name", { max: 120 })]);
    if(body.email_from_email !== undefined){
      const from = vEmail(body.email_from_email, "email from address", false);
      updates.push(["email_from_email", from || ""]);
    }
    if(body.email_reply_to !== undefined){
      const reply = vEmail(body.email_reply_to, "email reply-to address", false);
      updates.push(["email_reply_to", reply || ""]);
    }
    if(body.email_enabled !== undefined){
      const on = (body.email_enabled === true || body.email_enabled === "true" || body.email_enabled === 1);
      updates.push(["email_enabled", on ? "true" : "false"]);
    }
    if(!updates.length) throw err(422, "There is nothing to update.", "VALIDATION");
    for(const pair of updates){
      const existing = await dbGet(env, "SELECT key FROM app_settings WHERE key = ?", [pair[0]]);
      if(existing) await dbRun(env, "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?", [pair[1], touch(), pair[0]]);
      else await dbRun(env, "INSERT INTO app_settings (key, value) VALUES (?,?)", [pair[0], pair[1]]);
    }
    resetEmailSettingsCache();
    return ok({ settings: await ownerSettings(env), email: emailStatus(env, await loadEmailSettings(env, true)),
      message: "Platform settings saved." }, cors);
  }
  return ok({ settings: await ownerSettings(env), email: emailStatus(env, await loadEmailSettings(env, true)) }, cors);
}
async function routeOrganizerEventOrders(ctx){
  ctx.url.searchParams.set("event_id", ctx.params.id);
  return routeOrganizerOrders(ctx);
}
async function routeOrganizerEventAttendees(ctx){
  ctx.url.searchParams.set("event_id", ctx.params.id);
  return routeOrganizerAttendees(ctx);
}

/* ============================================================================
   PUBLIC: POST /api/tickets/send-email
   ----------------------------------------------------------------------------
   Called by ticket.html and payment-success.html. Public on purpose (buyers do
   not need an account) but rate limited, and it only ever emails the tickets of
   an order that has already been paid - never an unpaid reservation.
   ========================================================================== */
async function routeSendTicketEmail(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  /* Three tiers, because this endpoint sends a real email to an address the
     caller chooses: per IP, per order/ticket reference and per recipient. One
     address cannot be flooded from many hosts, and one paid order cannot be
     re-sent in a loop. */
  await guardRate(env, request, "ticket_email", {
    ref: body.order_number || body.order || body.reference || body.ticket_number || body.ticket,
    email: body.email
  });
  const ticketNumber = vStr(body.ticket_number || body.ticket, "ticket number", { max: 64 });
  const orderNumber = vStr(body.order_number || body.order || body.reference, "order number", { max: 64 });
  if(!ticketNumber && !orderNumber) throw err(422, "Provide a ticket number or an order number.", "VALIDATION");
  let order = orderNumber ? await dbGet(env, "SELECT * FROM orders WHERE order_number = ?", [orderNumber]) : null;
  if(!order && ticketNumber){
    const found = await dbGet(env, "SELECT order_id FROM tickets WHERE ticket_number = ? OR qr_token = ?", [ticketNumber, ticketNumber]);
    if(found) order = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [found.order_id]);
  }
  if(!order) throw err(404, "We could not find that ticket or order.", "NOT_FOUND");
  if(order.status !== "paid") throw err(409, "Tickets are emailed once the payment is confirmed.", "NOT_PAID");
  const to = vEmail(body.email, "email", false) || emailRecipient(order.customer_email);
  if(!to) throw err(422, "This order has no email address. Enter one and try again.", "NO_EMAIL");
  const status = emailStatus(env, await loadEmailSettings(env));
  if(!status.configured){
    throw err(503, "Email delivery is not switched on yet. Your tickets stay available on this page.", "EMAIL_NOT_CONFIGURED");
  }
  /* task = null so the send is awaited and the answer is truthful. */
  const result = await sendTicketResendEmail(env, order, request, to, null);
  if(!result.queued) throw err(500, "We could not queue that email. Please try again shortly.", "EMAIL_FAILED");
  const mine = ((result.delivery && result.delivery.results) || []).filter(r => r.id === result.id)[0] || null;
  if(mine && mine.result === "failed"){
    throw err(502, "The mail server refused the message. Our team can see it in the email outbox and will fix it.", "EMAIL_REJECTED");
  }
  return ok({
    to: to,
    order_number: order.order_number,
    template: "ticket_resend",
    queued: true,
    delivered: mine ? (mine.result === "sent") : null,
    message: "Tickets queued for " + to + "."
  }, corsFor(env, request));
}

/* ============================================================================
   OWNER: EMAIL ADMIN
   ----------------------------------------------------------------------------
   The outbox is inspectable and manageable from the owner area: what was sent,
   what failed and why, flush the queue, resend one message, send an approved
   template ad hoc (refund notices) and run a live delivery test.
   ========================================================================== */
const EMAIL_DISPATCH_LIMIT = 25;
async function routeOwnerEmails(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url;
  const cors = corsFor(env, request);
  await requireOwner(env, request);
  const where = ["1 = 1"], params = [];
  const status = vStr(url.searchParams.get("status"), "status", { max: 20 });
  if(status && status !== "all"){
    where.push("status = ?");
    params.push(vEnum(status, ["queued", "sent", "failed"], "status", "queued"));
  }
  const template = vStr(url.searchParams.get("template"), "template", { max: 40 });
  if(template && template !== "all"){
    if(!isTemplate(template)) throw err(422, "Unknown email template.", "VALIDATION");
    where.push("template = ?"); params.push(template);
  }
  const search = vStr(url.searchParams.get("q"), "search", { max: 80 });
  if(search){
    where.push("(to_email LIKE ? OR subject LIKE ? OR payload_json LIKE ?)");
    const like = "%" + search + "%";
    params.push(like, like, like);
  }
  const whereSql = " WHERE " + where.join(" AND ");
  const counted = await dbGet(env, "SELECT COUNT(*) AS n FROM email_outbox" + whereSql, params);
  const total = counted ? Number(counted.n) : 0;
  const p = paginate(url);
  const rows = await dbAll(env, "SELECT * FROM email_outbox" + whereSql + " ORDER BY id DESC LIMIT ? OFFSET ?",
    params.concat([p.limit, p.offset]));
  return ok({
    emails: rows.map(outboxRowView),
    stats: await outboxStats(env),
    provider: emailStatus(env, await loadEmailSettings(env)),
    templates: templateList(),
    meta: { page: p.page, limit: p.limit, total: total, pages: Math.max(1, Math.ceil(total / p.limit)) },
    total: total
  }, cors);
}
async function routeOwnerEmailTemplates(ctx){
  const env = ctx.env, request = ctx.request;
  await requireOwner(env, request);
  return ok({
    templates: templateList(),
    provider: emailStatus(env, await loadEmailSettings(env)),
    categories: ["transactional", "internal"]
  }, corsFor(env, request));
}
async function routeOwnerEmailDispatch(ctx){
  const env = ctx.env, request = ctx.request;
  await requireOwner(env, request);
  const body = await readJson(request);
  const limit = body.limit == null ? EMAIL_DISPATCH_LIMIT : vInt(body.limit, "limit", { min: 1, label: "Limit" });
  const summary = await dispatchOutbox(env, Math.min(limit, EMAIL_DISPATCH_LIMIT), { force: body.force === true });
  return ok({ dispatch: summary, stats: await outboxStats(env) }, corsFor(env, request));
}
async function routeOwnerEmailResend(ctx){
  const env = ctx.env, request = ctx.request;
  await requireOwner(env, request);
  const id = vInt(ctx.params.id, "email", { min: 1, label: "Email id" });
  const row = await requeueEmail(env, id);
  if(!row) throw err(404, "That email is not in the outbox.", "NOT_FOUND");
  const summary = await dispatchOutbox(env, EMAIL_DISPATCH_LIMIT);
  const mine = (summary.results || []).filter(r => r.id === id)[0] || null;
  return ok({
    email: row,
    dispatch: mine,
    stats: await outboxStats(env),
    message: (mine && mine.result === "sent") ? "Email delivered again." : "Email re-queued."
  }, corsFor(env, request));
}
async function routeOwnerEmailSend(ctx){
  const env = ctx.env, request = ctx.request;
  const cors = corsFor(env, request);
  const owner = await requireOwner(env, request);
  const body = await readJson(request);
  const template = vStr(body.template, "template", { required: true, max: 40 });
  /* Owner-triggered mail is capped per owner account and per IP, so a hijacked
     owner session cannot loop real messages out of the mail provider. */
  await guardRate(env, request, "owner_email", { uid: (owner.user && owner.user.firebase_uid) || "" });
  if(!isTemplate(template)) throw err(422, "Unknown email template.", "VALIDATION");
  if(templateCategory(template) === "internal" && body.confirm_internal !== true){
    throw err(422, "That template is an internal notification. Send it with confirm_internal: true.", "CONFIRM_REQUIRED");
  }
  const to = vEmail(body.to || body.email, "email", true);
  const toName = vStr(body.to_name, "name", { max: 120 });
  const payload = (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) ? body.payload : {};
  /* Freshly built folder URLs win over anything the caller sent, but only where
     they carry a value (emailLinks returns event:"" without an event), so a
     stored link is never blanked. Either side is folded off the legacy .html
     shape first, so re-sending an old row cannot resurrect /ticket.html. */
  payload.links = mergeEmailLinks(payload.links, emailLinks(env, request, null));
  normalisePayloadLinks(payload);
  if(toName) payload.customer = Object.assign({}, payload.customer || {}, { name: toName, email: to });
  const result = await sendTemplateNow(env, {
    template: template, to: to, to_name: toName,
    subject: vStr(body.subject, "subject", { max: 180 }), payload: payload
  });
  if(!result.ok){
    throw err(result.retryable ? 503 : 502, result.error || "The provider did not accept that email.", "EMAIL_FAILED");
  }
  return ok({
    to: to, template: template, subject: result.subject,
    message_id: result.message_id || null, message: "Email sent to " + to + "."
  }, cors);
}
async function routeOwnerEmailTest(ctx){
  const env = ctx.env, request = ctx.request;
  const session = await requireOwner(env, request);
  const body = await readJson(request);
  await guardRate(env, request, "owner_email", { uid: (session.user && session.user.firebase_uid) || "" });
  const to = vEmail(body.to || body.email, "email", false) || emailRecipient(session.user.email);
  if(!to) throw err(422, "Enter an email address to receive the test.", "VALIDATION");
  const result = await sendTestEmail(env, {
    to: to, to_name: session.user.full_name, requested_by: session.user.email,
    links: emailLinks(env, request, null)
  });
  if(!result.ok){
    throw err(result.retryable ? 503 : 502, result.error || "The test email was not accepted by Brevo.", "EMAIL_FAILED");
  }
  return ok({
    to: to, template: "test_email", subject: result.subject,
    message_id: result.message_id || null, message: "Test email sent to " + to + "."
  }, corsFor(env, request));
}

/* ============================================================================
   FREE TICKET VERIFICATION  (Email OTP + IP abuse prevention + duplicate guard)
   ----------------------------------------------------------------------------
   The single home for the free-ticket flow. Paid tickets never touch this code:
   POST /api/orders and /api/payments/* are unchanged, and markOrderPaid() - the
   ONLY path that issues tickets - is REUSED here, so a free registration
   produces exactly the same order, payment row, tickets and QR codes as any
   other order, and the existing paid flow cannot be reached from these routes.

   The three endpoints:
     POST /api/tickets/free/verify/request   issue (or re-issue) a 6-digit OTP
     POST /api/tickets/free/verify/confirm   check the OTP, mint a continuation token
     POST /api/tickets/free/register         atomically claim + issue the ticket(s)

   Server-side truth only. The client proves nothing by sending a flag: the
   continuation token is looked up by its HASH in D1, and the session's own
   event / email / quantity are reused, so a browser that raises the quantity or
   swaps the event after verification changes nothing. The per-email limit is
   enforced by a PARTIAL UNIQUE index on the claim table - the reason two
   simultaneous requests cannot both slip past it.

   PRIVACY: the six digits are stored only as a keyed HMAC; IP addresses are
   stored only as an HMAC; claim rows carry an email HASH, never the address.
   No code, raw IP or token is ever written to a log or returned beyond the one
   client that needs it.
   ========================================================================== */
/* The keyed secret behind every hash in this feature. FREE_TICKET_OTP_KEY is the
   documented secret; the fallbacks keep an existing deployment working without a
   code change (PAYMENT_ENCRYPTION_KEY is already required before an organizer
   can connect payments). */
function freeKeyMaterial(env){
  return String((env && (env.FREE_TICKET_OTP_KEY || env.PAYMENT_ENCRYPTION_KEY ||
    env.TURNSTILE_SECRET || env.TURNSTILE_SECRET_KEY)) || "");
}
function freeOtpKeyReady(env){ return !!freeKeyMaterial(env); }
/* HMAC(secret, "otp|<session token>|<code>"). Tying the hash to the session token
   means a code harvested for one session is worthless in any other. */
async function freeOtpHash(env, sessionToken, code){
  const secret = freeKeyMaterial(env);
  if(!secret) throw err(500, "Free ticket verification is not configured on this server.", "OTP_KEY_MISSING");
  return hmacSha256Hex(secret, "otp|" + String(sessionToken) + "|" + String(code));
}
/* Privacy reference for an email address or an IP. A static string is the very
   last resort so duplicate prevention keeps working on a deployment that never
   set a secret; the value is never returned to a client and never logged. */
async function freeIdentityHash(env, kind, value){
  const secret = freeKeyMaterial(env) || "tickethub-free-static";
  return (await hmacSha256Hex(secret, kind + "|" + String(value == null ? "" : value))).slice(0, 48);
}
/* Cryptographically secure 6-digit code with rejection sampling: byte values
   >= 250 are discarded (250 = 25*10), so every digit is exactly uniform - no
   modulo bias - and the digits come straight from crypto.getRandomValues(). */
function freeOtpCode(len){
  const want = len || 6;
  const out = [];
  const buf = new Uint8Array(32);
  while(out.length < want){
    crypto.getRandomValues(buf);
    for(const b of buf){
      if(out.length >= want) break;
      if(b < 250) out.push(String(b % 10));
    }
  }
  return out.join("");
}
function digitsOnly(v){ return String(v == null ? "" : v).replace(/[^0-9]/g, ""); }
/* An IPv6-mapped IPv4 address is the same host as its IPv4 form, so it is
   normalised before hashing - otherwise ::ffff:1.2.3.4 and 1.2.3.4 would count
   as two clients. Client-supplied IP headers are NEVER read here: callers pass
   clientIp(request), which only trusts Cloudflare's CF-Connecting-IP. */
function normaliseIp(raw){
  let s = String(raw == null ? "" : raw).trim().toLowerCase();
  if(!s) return "";
  if(s.charAt(0) === "["){ const end = s.indexOf("]"); if(end > 0) s = s.slice(1, end) + s.slice(end + 1); }
  const pct = s.indexOf("%"); if(pct > -1) s = s.slice(0, pct);          // zone id
  if(s.indexOf("::ffff:") === 0) s = s.slice(7);                          // v4-mapped v6
  return s;
}
function maskEmail(email){
  const s = normaliseEmail(email);
  const at = s.indexOf("@");
  if(at < 1) return s ? s.charAt(0) + "***" : "";
  const local = s.slice(0, at), domain = s.slice(at);
  if(local.length <= 2) return local.charAt(0) + "***" + domain;
  return local.charAt(0) + "***" + local.charAt(local.length - 1) + domain;
}
function isoStamp(ms){ return new Date(Number(ms)).toISOString(); }
function stampMs(value){
  const t = Date.parse(String(value == null ? "" : value));
  return Number.isFinite(t) ? t : 0;
}


/* Resolves events.free_ticket_limit / free_otp_enabled / ip_abuse_enabled and
   the optional JSON threshold overrides into a plain, validated object. A value
   outside its safe bound is clamped, never honoured raw, so an organizer cannot
   switch their own protection off with a crafted payload. */
function clampInt(value, min, max, dflt){
  const n = Number(value);
  if(!Number.isFinite(n)) return dflt;
  const f = Math.floor(n);
  if(f < min) return min;
  if(f > max) return max;
  return f;
}
function boolFlag(v){ return v === true || v === 1 || v === "1" || v === "true" || v === "on"; }
/* Only the four known threshold keys are ever written, each clamped to its safe
   bound, so a crafted payload cannot store an out-of-range value. Anything else
   (or nothing) becomes NULL = "use the platform default". */
function normalizeFreeTicketConfig(value){
  let src = value;
  if(typeof src === "string"){ try { src = JSON.parse(src); } catch(e){ return null; } }
  if(!src || typeof src !== "object" || Array.isArray(src)) return null;
  const out = {};
  for(const key of Object.keys(FREE_RATE_BOUNDS)){
    if(src[key] === undefined || src[key] === null || src[key] === "") continue;
    const b = FREE_RATE_BOUNDS[key];
    out[key] = clampInt(src[key], b.min, b.max, b.dflt);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
function freeTicketConfig(ev){
  const enabled = (!ev || ev.free_otp_enabled === undefined || ev.free_otp_enabled === null)
    ? true : Number(ev.free_otp_enabled) === 1;
  const ipAbuse = (!ev || ev.ip_abuse_enabled === undefined || ev.ip_abuse_enabled === null)
    ? true : Number(ev.ip_abuse_enabled) === 1;
  const limit = clampInt(ev && ev.free_ticket_limit, FREE_TICKET_LIMIT_MIN, FREE_TICKET_LIMIT_MAX, 1);
  let extra = {};
  if(ev && ev.free_ticket_config){
    try {
      const parsed = JSON.parse(ev.free_ticket_config);
      if(parsed && typeof parsed === "object" && !Array.isArray(parsed)) extra = parsed;
    } catch(e){ extra = {}; }
  }
  const out = { otp_enabled: enabled, ip_abuse: ipAbuse, limit: limit };
  for(const key of Object.keys(FREE_RATE_BOUNDS)){
    const b = FREE_RATE_BOUNDS[key];
    out[key] = (extra[key] === undefined || extra[key] === null) ? null : clampInt(extra[key], b.min, b.max, b.dflt);
  }
  return out;
}
/* Effective limit for one tier: event override (already clamped) -> env var ->
   the built-in default. Precedence is deliberate: a deployment owner's env var
   wins, then the event's own tightened value, then the platform default. */
function freeTierLimit(env, envName, cfgValue, dflt){
  return envRateNumber(env, envName, cfgValue == null ? dflt : cfgValue);
}
/* One tier of an event-scoped limit, enforced with the same memory -> binding ->
   D1 primitive every other route uses (rateLimit), so a per-event threshold is
   a real cross-isolate limit, not an in-memory counter. The key carries the
   event id, so two events never share a counter. */
async function freeRateGuard(env, request, opts){
  const id = String(opts.id || "");
  if(!id || id === "unknown") return null;
  const subject = opts.by === "email" ? ("h" + (await sha256Hex(id)).slice(0, 24)) : id;
  const key = "free:" + opts.action + ":" + opts.by + ":" + subject + ":e" + opts.event_id;
  try {
    return await rateLimit({ env: env, key: key, limit: opts.limit,
      windowSeconds: opts.window, action: opts.action, store: "d1" });
  } catch(e){
    if(e && e.rateAction){
      securityLog(rateEventFor(opts.action), request, {
        action: opts.action, tier: e.rateTier, limit: e.rateLimit,
        source: e.rateSource, event_id: opts.event_id
      });
    }
    throw e;
  }
}
/* The event-level gate shared by all three routes: the same wording the buyer
   already sees on the paid checkout, so the two flows behave identically. */
function assertEventOnSale(ev){
  if(String(ev.status) !== "active") throw err(409, "Tickets for this event are not on sale right now.", "NOT_ON_SALE");
  const today = keToday();
  if(String(ev.event_date).slice(0, 10) < today) throw err(409, "This event has already taken place.", "EVENT_ENDED");
  if(ev.sales_end && String(ev.sales_end).slice(0, 10) < today) throw err(409, "Ticket sales for this event have closed.", "SALES_CLOSED");
  if(ev.sales_start && String(ev.sales_start).slice(0, 10) > today) throw err(409, "Ticket sales for this event have not opened yet.", "SALES_NOT_OPEN");
}
/* The live, free (price = 0) ticket types for an event. */
async function freeTicketTypes(env, eventId){
  const rows = await dbAll(env, "SELECT * FROM ticket_types WHERE event_id = ? AND price = 0 ORDER BY id ASC", [eventId]);
  return rows.filter(t => ticketOnSale(t));
}
async function resolveFreeTicketType(env, eventId, wantedId){
  const list = await freeTicketTypes(env, eventId);
  if(!list.length) return null;
  if(wantedId == null) return list[0];
  return list.filter(t => Number(t.id) === Number(wantedId))[0] || null;
}
async function freeSessionByToken(env, token){
  const t = String(token || "").trim();
  if(t.length < 16 || t.length > 200) return null;
  return dbGet(env, "SELECT * FROM free_ticket_sessions WHERE session_token = ?", [t]);
}
async function freeSessionByContinue(env, token){
  const t = String(token || "").trim();
  if(t.length < 16 || t.length > 200) return null;
  const hash = await freeIdentityHash(env, "continue", t);
  return dbGet(env, "SELECT * FROM free_ticket_sessions WHERE continue_hash = ?", [hash]);
}

/* How many free ticket slots an email already holds for an event: the count of
   ACTIVE claim rows. Released rows (cancelled / refunded registrations) do not
   count, which is why the unique index only covers active rows. */
async function freeClaimUsage(env, eventId, emailHash){
  const row = await dbGet(env,
    "SELECT COUNT(*) AS n FROM free_ticket_claims WHERE event_id = ? AND email_hash = ? AND status = 'active'",
    [eventId, emailHash]);
  return row ? Number(row.n) : 0;
}
async function freeActiveSlots(env, eventId, emailHash){
  const rows = await dbAll(env,
    "SELECT slot FROM free_ticket_claims WHERE event_id = ? AND email_hash = ? AND status = 'active'", [eventId, emailHash]);
  return rows.map(r => Number(r.slot));
}
/* Releases the slots held by an order that was cancelled, failed or refunded.
   Called wherever inventory is released, so a cancelled free registration does
   not keep someone's limit consumed forever. */
async function releaseFreeTicketClaims(env, orderId){
  if(orderId == null) return 0;
  const res = await dbRun(env,
    "UPDATE free_ticket_claims SET status = 'released', updated_at = ? WHERE order_id = ? AND status = 'active'",
    [touch(), orderId]);
  return (res && res.meta && Number(res.meta.changes)) || 0;
}
/* Takes `qty` free ticket slots for an email, atomically. The UNIQUE partial
   index on (event_id,email_hash,slot) WHERE status='active' is the guard: if two
   isolates race for the same slot, the loser gets a constraint error. The loser
   releases anything IT managed to insert first, so a failed race can never leak a
   consumed slot, and returns null (the caller answers 409). */
async function claimFreeSlots(env, eventId, emailHash, qty, meta){
  const taken = new Set(await freeActiveSlots(env, eventId, emailHash));
  const ids = [];
  let slot = 1;
  const releaseInserted = async () => {
    if(!ids.length) return;
    await dbRun(env, "UPDATE free_ticket_claims SET status = 'released', updated_at = ? WHERE id IN (" + ids.map(() => "?").join(",") + ")",
      [touch()].concat(ids));
  };
  for(let made = 0; made < qty; made++){
    while(taken.has(slot)) slot++;
    let res = null;
    try {
      res = await dbRun(env,
        "INSERT INTO free_ticket_claims (event_id, email_hash, slot, order_id, session_id, quantity, status, ip_hash, updated_at) VALUES (?,?,?,?,?,1,'active',?,?)",
        [eventId, emailHash, slot, meta.order_id || null, meta.session_id || null, meta.ip_hash || null, touch()]);
    } catch(e){
      await releaseInserted();
      return null;
    }
    const id = (res && res.meta && res.meta.last_row_id) ? res.meta.last_row_id : null;
    if(!id){ await releaseInserted(); return null; }
    taken.add(slot);
    ids.push(id);
    slot++;
  }
  return ids;
}
/* Sends the OTP through the existing Brevo pipeline (sendTemplateNow) rather than
   the queue: the queue persists its payload, and the six digits must never sit in
   D1 in clear. The send is immediate and nothing is written to email_outbox, so a
   delivery failure cannot leave a usable code behind either. Returns the send
   result; the caller invalidates the session when it is not ok. */
async function sendFreeOtpEmail(env, ev, org, links, to, name, code, quantity, ticketTypeName){
  return sendTemplateNow(env, {
    template: "free_ticket_otp",
    to: to,
    to_name: name || "",
    links: links,
    payload: {
      brand: await emailBrandFor(env),
      links: links,
      customer: { name: name || "", email: to },
      event: eventEmailPayload(ev, org, links),
      items: [{ name: ticketTypeName || "Free ticket", quantity: quantity, unit_price: 0, subtotal: 0 }],
      meta: { code: code, expires_minutes: Math.round(FREE_OTP_TTL_SEC / 60), quantity: quantity,
              event_id: ev ? ev.id : null, purpose: "free_ticket_verification" }
    }
  });
}

/* Sends a freshly generated code for a session and returns the client payload.
   Used by BOTH the first request and a resend, so the masking, expiry, cooldown
   and wording are identical. A provider failure burns the session (status
   'expired') so a failed send can never be retried into a usable code. */
async function deliverFreeOtp(env, request, ev, session, code){
  const org = await dbGet(env, "SELECT * FROM organizers WHERE id = ?", [ev.organizer_id]);
  const links = emailLinks(env, request, ev);
  const type = session.ticket_type_id ? await dbGet(env, "SELECT * FROM ticket_types WHERE id = ?", [session.ticket_type_id]) : null;
  const send = await sendFreeOtpEmail(env, ev, org, links, session.email, session.name, code,
    Number(session.quantity) || 1, type ? type.name : "Free ticket");
  if(!send || !send.ok){
    await dbRun(env, "UPDATE free_ticket_sessions SET status = 'expired' WHERE id = ?", [session.id]);
    /* Provider detail stays in the Worker log; the client gets a safe sentence. */
    console.error("FREE_OTP_SEND_FAILED", ev && ev.id, (send && (send.error || "")) || "unknown");
    if(send && send.skipped){
      throw err(503, "Free-ticket email verification is not configured on this server, so a code cannot be sent. Please contact the organizer.", "EMAIL_NOT_CONFIGURED");
    }
    throw err(502, "We could not send the verification code. Please try again.", "EMAIL_FAILED");
  }
  const masked = maskEmail(session.email);
  return {
    session_token: session.session_token,
    email_masked: masked,
    quantity: Number(session.quantity) || 1,
    expires_in: FREE_OTP_TTL_SEC,
    resend_after: FREE_OTP_RESEND_COOLDOWN_SEC,
    attempts_allowed: FREE_OTP_MAX_ATTEMPTS,
    message: "We sent a 6-digit verification code to " + masked + ". It expires in " + Math.round(FREE_OTP_TTL_SEC / 60) + " minutes."
  };
}
/* Writes a new code onto an existing pending session (resend): replace the hash,
   extend the expiry, bump the resend counter and stamp the send time in ONE
   statement, so a concurrent confirm can never observe a half-updated row. */
async function reissueFreeOtpRow(env, sessionId, otpHash, nowMs, fromResend){
  await dbRun(env,
    "UPDATE free_ticket_sessions SET otp_hash = ?, attempts = 0, resends = resends + ?, expires_at = ?, last_sent_at = ?, verified_at = NULL, continue_hash = NULL, continue_expires_at = NULL WHERE id = ? AND status = 'pending'",
    [otpHash, fromResend ? 1 : 0, isoStamp(nowMs + FREE_OTP_TTL_SEC * 1000), isoStamp(nowMs), sessionId]);
  return dbGet(env, "SELECT * FROM free_ticket_sessions WHERE id = ?", [sessionId]);
}

/* ------------------------------------------- POST /api/tickets/free/verify/request
   Issues (or re-issues) the 6-digit code. The response NEVER reveals whether the
   address is already registered, and never echoes the code itself. */
async function routeFreeVerifyRequest(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  const eventId = vInt(body.event_id, "event", { min: 1, label: "Event" });
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [eventId]);
  if(!ev) throw err(404, "This event is no longer available.", "NOT_FOUND");
  const cfg = freeTicketConfig(ev);
  if(!cfg.otp_enabled) throw err(409, "Email verification is not required for this event.", "OTP_DISABLED");
  if(!freeOtpKeyReady(env)) throw err(500, "Free ticket verification is not configured on the server.", "OTP_KEY_MISSING");
  assertEventOnSale(ev);

  const ip = normaliseIp(clientIp(request));
  const ipHash = ip ? await freeIdentityHash(env, "ip", ip) : null;
  /* IP abuse prevention is counted BEFORE any email work (and before the
     challenge), so a flood costs no Siteverify round trip and no send. */
  if(cfg.ip_abuse){
    await freeRateGuard(env, request, {
      by: "ip", id: ip, action: "free_otp", event_id: ev.id,
      limit: freeTierLimit(env, "FREE_OTP_IP_LIMIT", cfg.otp_ip_limit, FREE_RATE_BOUNDS.otp_ip_limit.dflt),
      window: freeTierLimit(env, "FREE_OTP_IP_WINDOW", cfg.otp_ip_window, FREE_RATE_BOUNDS.otp_ip_window.dflt)
    });
  }
  const now = Date.now();

  /* ---- resend: reuse the existing session, cooldown + cap enforced --------- */
  const resendToken = String(body.session_token || "").trim();
  if(resendToken){
    const session = await freeSessionByToken(env, resendToken);
    if(!session || Number(session.event_id) !== Number(ev.id))
      throw err(410, "That verification session has expired. Please start again.", "SESSION_EXPIRED");
    if(String(session.status) !== "pending")
      throw err(409, "That verification code can no longer be re-sent. Please start again.", "SESSION_CLOSED");
    const since = now - stampMs(session.last_sent_at);
    if(since < FREE_OTP_RESEND_COOLDOWN_SEC * 1000){
      const e = err(429, "Please wait a moment before requesting another code.", "RESEND_COOLDOWN");
      e.retryAfter = Math.max(1, Math.ceil((FREE_OTP_RESEND_COOLDOWN_SEC * 1000 - since) / 1000));
      throw e;
    }
    if(Number(session.resends) >= FREE_OTP_MAX_RESENDS)
      throw err(429, "Too many codes requested for this session. Please wait, then start again.", "RESEND_LIMIT");
    await freeRateGuard(env, request, { by: "email", id: session.email, action: "free_otp", event_id: ev.id,
      limit: freeTierLimit(env, "FREE_OTP_EMAIL_LIMIT", null, 5), window: 3600 });
    const code = freeOtpCode(6);
    const updated = await reissueFreeOtpRow(env, session.id, await freeOtpHash(env, session.session_token, code), now, true);
    if(!updated) throw err(409, "That verification session has expired. Please start again.", "SESSION_CLOSED");
    return ok(await deliverFreeOtp(env, request, ev, updated, code), corsFor(env, request));
  }

  /* ---- first request ----------------------------------------------------- */
  const name = vStr(body.full_name || body.name || (body.customer && body.customer.full_name), "full name",
    { required: true, min: 3, max: 120, label: "Full name" });
  const email = normaliseEmail(vEmail(body.email || (body.customer && body.customer.email), "email address", true));
  const quantity = clampInt(body.quantity == null ? 1 : body.quantity, 1, cfg.limit, 1);
  const wantedTypeId = body.ticket_type_id == null ? null : vInt(body.ticket_type_id, "ticket type", { min: 1, label: "Ticket type" });
  const type = await resolveFreeTicketType(env, ev.id, wantedTypeId);
  if(!type) throw err(409, "This event does not have a free ticket on sale right now.", "NO_FREE_TICKETS");
  /* Bot protection on the one request that triggers an email. Skipped only when
     the deployment has no TURNSTILE_SECRET - the same behaviour as checkout. */
  await requireTurnstile(env, request, body, "checkout");
  /* Per-email window on top of the per-IP one, so one address cannot be spammed. */
  await freeRateGuard(env, request, { by: "email", id: email, action: "free_otp", event_id: ev.id,
    limit: freeTierLimit(env, "FREE_OTP_EMAIL_LIMIT", null, 5), window: 3600 });

  const emailHash = await freeIdentityHash(env, "email", email);
  /* Supersede every earlier pending session for this event + email: only the
     newest code is ever valid, so an older email cannot be replayed. */
  await dbRun(env,
    "UPDATE free_ticket_sessions SET status = 'superseded' WHERE event_id = ? AND email_hash = ? AND status = 'pending'",
    [ev.id, emailHash]);
  const sessionToken = randomToken(32);
  const code = freeOtpCode(6);
  const otpHash = await freeOtpHash(env, sessionToken, code);
  const ins = await dbRun(env,
    "INSERT INTO free_ticket_sessions (session_token, event_id, email, email_hash, name, quantity, ticket_type_id, otp_hash, status, ip_hash, expires_at, last_sent_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)",
    [sessionToken, ev.id, email, emailHash, name, quantity, type.id, otpHash, ipHash,
     isoStamp(now + FREE_OTP_TTL_SEC * 1000), isoStamp(now)]);
  const sessionId = (ins && ins.meta && ins.meta.last_row_id) ? ins.meta.last_row_id : null;
  if(!sessionId) throw err(500, "We could not start the verification. Please try again.", "SESSION_FAILED");
  const session = await dbGet(env, "SELECT * FROM free_ticket_sessions WHERE id = ?", [sessionId]);
  /* Opportunistic retention sweep (throttled per isolate), so expiry cleanup does
     not depend on a cron trigger being configured. */
  if(ctx.ctx && typeof ctx.ctx.waitUntil === "function") ctx.ctx.waitUntil(freeTicketSweep(env, false));
  return ok(await deliverFreeOtp(env, request, ev, session, code), corsFor(env, request));
}

/* ------------------------------------------- POST /api/tickets/free/verify/confirm
   Checks the code. The attempt counter is incremented FIRST (one atomic UPDATE,
   capped by a WHERE clause) so the 5-try budget cannot be beaten by racing
   requests; only then is the hash compared, in constant time. On success the
   session flips to 'verified' and a single-use continuation token - stored only
   as a hash - is minted. A verified session can never be re-verified, so a
   successful code is used exactly once. */
async function routeFreeVerifyConfirm(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  const token = vStr(body.session_token || body.verification_session, "verification session",
    { required: true, max: 200, label: "Verification session" });
  const code = digitsOnly(body.otp || body.code);
  const session = await freeSessionByToken(env, token);
  /* One generic refusal for "no such session" / "wrong code", so a caller cannot
     probe which sessions exist or how close a guess was. */
  const invalid = () => err(400, "Invalid or expired verification code. Please try again.", "OTP_INVALID");
  if(!session) throw invalid();
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [session.event_id]);
  if(!ev) throw invalid();
  const cfg = freeTicketConfig(ev);
  const ip = normaliseIp(clientIp(request));
  /* Per-IP failed-attempt window: defence in depth on top of the per-session cap. */
  if(cfg.ip_abuse){
    await freeRateGuard(env, request, { by: "ip", id: ip, action: "free_verify", event_id: ev.id,
      limit: freeTierLimit(env, "FREE_VERIFY_IP_LIMIT", null, 15),
      window: freeTierLimit(env, "FREE_VERIFY_IP_WINDOW", null, 900) });
  }
  const now = Date.now();
  if(String(session.status) === "verified")
    throw err(409, "This email is already verified. Complete your registration, or start again if you need a new code.", "ALREADY_VERIFIED");
  if(String(session.status) !== "pending")
    throw err(410, "That verification session has expired. Please start again.", "SESSION_EXPIRED");
  if(stampMs(session.expires_at) <= now){
    await dbRun(env, "UPDATE free_ticket_sessions SET status = 'expired' WHERE id = ? AND status = 'pending'", [session.id]);
    throw err(410, "Your verification code has expired. Request a new one.", "OTP_EXPIRED");
  }
  const tried = await dbRun(env,
    "UPDATE free_ticket_sessions SET attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts < ?",
    [session.id, FREE_OTP_MAX_ATTEMPTS]);
  if(!(tried && tried.meta && Number(tried.meta.changes) === 1)){
    await dbRun(env, "UPDATE free_ticket_sessions SET status = 'expired' WHERE id = ? AND status = 'pending'", [session.id]);
    throw err(429, "Too many incorrect codes. Please request a new one.", "OTP_ATTEMPTS");
  }
  if(code.length !== 6){
    const left = Math.max(0, FREE_OTP_MAX_ATTEMPTS - (Number(session.attempts) + 1));
    throw err(400, "Invalid or expired verification code. Please try again." + (left ? " " + left + " attempt" + (left === 1 ? "" : "s") + " left." : ""), "OTP_INVALID");
  }
  const expected = String(session.otp_hash || "");
  const actual = await freeOtpHash(env, session.session_token, code);
  if(!safeEqual(expected, actual)){
    const left = Math.max(0, FREE_OTP_MAX_ATTEMPTS - (Number(session.attempts) + 1));
    throw err(400, "Invalid or expired verification code. Please try again." + (left ? " " + left + " attempt" + (left === 1 ? "" : "s") + " left." : ""), "OTP_INVALID");
  }
  /* Correct: mint the single-use continuation token (stored as a hash only). */
  const continueToken = randomToken(32);
  const continueHash = await freeIdentityHash(env, "continue", continueToken);
  const upd = await dbRun(env,
    "UPDATE free_ticket_sessions SET status = 'verified', verified_at = ?, continue_hash = ?, continue_expires_at = ? WHERE id = ? AND status = 'pending'",
    [isoStamp(now), continueHash, isoStamp(now + FREE_CONTINUE_TTL_SEC * 1000), session.id]);
  if(!(upd && upd.meta && Number(upd.meta.changes) === 1))
    throw err(409, "That code was already used. Please start again.", "SESSION_CLOSED");
  securityLog("FREE_TICKET_EMAIL_VERIFIED", request, { event_id: ev.id, session_id: session.id });
  return ok({
    verified: true, continue_token: continueToken, session_token: session.session_token,
    continue_expires_in: FREE_CONTINUE_TTL_SEC,
    email_masked: maskEmail(session.email), quantity: Number(session.quantity) || 1,
    message: "Email verified. You can now complete your free registration."
  }, corsFor(env, request));
}

/* ------------------------------------------- POST /api/tickets/free/register
   Completes a verified free registration. The continuation token is resolved
   server-side; the session's OWN event / email / name / quantity are reused, so
   a client that edits the payload changes nothing. The order, its items, its
   payment row and its tickets are created exactly like any other order, through
   the same markOrderPaid()/generateTickets() path, so QR codes, emails and the
   payment records stay identical - and a paid ticket can never come out of here
   because a price-0 ticket type is required. */
async function routeFreeRegister(ctx){
  const env = ctx.env, request = ctx.request;
  const body = await readJson(request);
  const token = vStr(body.continue_token || body.verification_token || body.session_token, "continuation token",
    { required: true, max: 200, label: "Continuation token" });
  const session = await freeSessionByContinue(env, token);
  if(!session) throw err(401, "Your email verification has expired or is invalid. Please verify again.", "VERIFY_REQUIRED");
  const now = Date.now();
  if(String(session.status) === "consumed")
    throw err(409, "This registration is already complete. Check your email for the ticket.", "ALREADY_REGISTERED");
  if(String(session.status) !== "verified")
    throw err(401, "Your email verification has expired or is invalid. Please verify again.", "VERIFY_REQUIRED");
  if(stampMs(session.continue_expires_at) <= now)
    throw err(410, "Your email verification has expired. Please verify again.", "VERIFY_EXPIRED");
  const ev = await dbGet(env, "SELECT * FROM events WHERE id = ?", [session.event_id]);
  if(!ev) throw err(404, "This event is no longer available.", "NOT_FOUND");
  const cfg = freeTicketConfig(ev);
  /* The client may only add a phone number. Everything else is taken from the
     session, so tampering with the payload is a no-op (and is rejected loudly). */
  if(body.event_id != null && Number(body.event_id) !== Number(ev.id))
    throw err(403, "This verification does not belong to that event.", "SESSION_EVENT_MISMATCH");
  const bodyEmail = normaliseEmail(body.email || (body.customer && body.customer.email));
  if(bodyEmail && bodyEmail !== normaliseEmail(session.email))
    throw err(403, "This verification does not belong to that email address.", "SESSION_EMAIL_MISMATCH");
  if(body.quantity != null && Number(body.quantity) !== Number(session.quantity))
    throw err(409, "The ticket quantity cannot be changed after verification.", "QUANTITY_MISMATCH");
  const phone = vPhone(body.phone || (body.customer && body.customer.phone), "phone number", true);

  const ip = normaliseIp(clientIp(request));
  const ipHash = ip ? await freeIdentityHash(env, "ip", ip) : null;
  if(cfg.ip_abuse){
    await freeRateGuard(env, request, { by: "ip", id: ip, action: "free_register", event_id: ev.id,
      limit: freeTierLimit(env, "FREE_REGISTER_IP_LIMIT", cfg.register_ip_limit, FREE_RATE_BOUNDS.register_ip_limit.dflt),
      window: freeTierLimit(env, "FREE_REGISTER_IP_WINDOW", cfg.register_ip_window, FREE_RATE_BOUNDS.register_ip_window.dflt) });
  }
  assertEventOnSale(ev);

  const type = session.ticket_type_id
    ? await dbGet(env, "SELECT * FROM ticket_types WHERE id = ? AND event_id = ?", [session.ticket_type_id, ev.id])
    : null;
  if(!type || Number(type.price) !== 0)
    throw err(409, "The free ticket for this event is no longer available.", "NO_FREE_TICKETS");
  if(!ticketOnSale(type)){
    const available = Math.max(0, Number(type.quantity) - Number(type.sold));
    throw err(409, available <= 0 ? (type.name + " is sold out.") : (type.name + " is not on sale right now."),
      available <= 0 ? "SOLD_OUT" : "NOT_ON_SALE");
  }

  const qty = Math.max(1, Number(session.quantity) || 1);
  const emailHash = String(session.email_hash);
  const used = await freeClaimUsage(env, ev.id, emailHash);
  const remaining = cfg.limit - used;
  if(remaining <= 0)
    throw err(409, "This email has already claimed the maximum of " + cfg.limit + " free ticket" + (cfg.limit === 1 ? "" : "s") + " for this event.", "FREE_LIMIT_REACHED");
  if(qty > remaining)
    throw err(409, "This email can claim " + remaining + " more free ticket" + (remaining === 1 ? "" : "s") + " for this event.", "FREE_LIMIT_EXCEEDED");

  /* Reserve inventory first (atomic UPDATE ... WHERE sold + qty <= quantity), then
     take the claim slots (atomic via the unique index). A later failure releases
     both, so a sold-out or raced request consumes nothing. */
  let claims = null, orderId = null, stockTaken = false;
  if(!(await reserveStock(env, type.id, qty))){
    const available = Math.max(0, Number(type.quantity) - Number(type.sold));
    throw err(409, available > 0 ? ("Only " + available + " left for " + type.name + ".") : (type.name + " is sold out."), "SOLD_OUT");
  }
  stockTaken = true;
  try {
    claims = await claimFreeSlots(env, ev.id, emailHash, qty, { session_id: session.id, ip_hash: ipHash });
    if(!claims || claims.length !== qty)
      throw err(409, "This email has already claimed the maximum number of free tickets for this event.", "FREE_LIMIT_RACE");
    const resolved = await resolveEffectiveProvider(env, { event: ev });
    const providerKey = resolved.provider_key || providerKeyOf(resolved.settings);
    const orderNo = await uniqueOrderNumber(env);
    const ins = await dbRun(env,
      "INSERT INTO orders (order_number, event_id, organizer_id, customer_name, customer_email, customer_phone, total_amount, currency, status, inventory_held) VALUES (?,?,?,?,?,?,0,'KES','pending',1)",
      [orderNo, ev.id, ev.organizer_id, session.name, session.email, phone]);
    orderId = (ins && ins.meta && ins.meta.last_row_id) ? ins.meta.last_row_id : null;
    if(!orderId) throw err(500, "We could not create your registration. Please try again.", "ORDER_FAILED");
    await dbRun(env, "INSERT INTO order_items (order_id, ticket_type_id, ticket_type_name, quantity, unit_price, subtotal) VALUES (?,?,?,?,0,0)",
      [orderId, type.id, type.name, qty]);
    await dbRun(env, "INSERT INTO payments (order_id, provider, reference, amount, currency, status) VALUES (?,?,?,0,'KES','pending')",
      [orderId, providerKey, orderNo]);
    await stampOrderMoneyTrail(env, orderId, resolved, providerKey);
    await dbRun(env, "UPDATE free_ticket_claims SET order_id = ?, updated_at = ? WHERE id IN (" + claims.map(() => "?").join(",") + ")",
      [orderId, touch()].concat(claims));
    const order = await dbGet(env, "SELECT * FROM orders WHERE id = ?", [orderId]);
    const payment = await dbGet(env, "SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC", [orderId]);
    /* The ONE path that issues tickets. It also queues the ticket_ready email and
       the organizer's new_sale alert, exactly as a paid order does. */
    const done = await markOrderPaid(env, order, payment, null, { free_order: true, verified_email: true }, request, ctx.ctx);
    /* Burn the session: the continuation token is single use. */
    await dbRun(env, "UPDATE free_ticket_sessions SET status = 'consumed', consumed_at = ? WHERE id = ?", [isoStamp(now), session.id]);
    const items = await orderItemsFor(env, orderId);
    const rows = await dbAll(env, TICKET_SELECT + " WHERE t.order_id = ? ORDER BY t.id ASC", [orderId]);
    const listed = rows.map(t => ticketPayload(t, { qr_image_url: qrUrlFor(request, t.ticket_number) }));
    return created({
      order: orderPayload(done.order, items, payment, listed),
      tickets: listed,
      verification: { email_masked: maskEmail(session.email), verified: true },
      message: "Your free ticket" + (listed.length === 1 ? " is" : "s are") + " confirmed. A copy has been emailed to you."
    }, corsFor(env, request));
  } catch(e){
    /* If the order already reached 'paid' the tickets exist: keep everything and
       let the error surface - a completed registration is never cancelled. */
    const current = orderId != null ? await dbGet(env, "SELECT status FROM orders WHERE id = ?", [orderId]) : null;
    if(current && String(current.status) === "paid") throw e;
    if(orderId != null){
      await releaseFreeTicketClaims(env, orderId);
      await dbRun(env, "UPDATE orders SET status = 'cancelled', inventory_held = 0, updated_at = ? WHERE id = ? AND status = 'pending'", [touch(), orderId]);
      await dbRun(env, "UPDATE payments SET status = 'failed', updated_at = ? WHERE order_id = ? AND status = 'pending'", [touch(), orderId]);
    } else if(claims && claims.length){
      await dbRun(env, "UPDATE free_ticket_claims SET status = 'released', updated_at = ? WHERE id IN (" + claims.map(() => "?").join(",") + ")",
        [touch()].concat(claims));
    }
    if(stockTaken) await releaseStock(env, type.id, qty);
    throw e;
  }
}

/* Aggregate free-ticket statistics for one event, for the organizer dashboard.
   NO personal data leaves here: counts only, never an address, an IP or a token.
   "Recent throttles" is the number of live rate-limit rows for this event's
   free-ticket actions - rows expire with their window, so it reflects the current
   window rather than all time. */
async function freeTicketStats(env, eventId){
  const id = Number(eventId);
  const one = async (sql, params) => { const r = await dbGet(env, sql, params); return r ? Number(r.n) : 0; };
  const sessions = await dbGet(env,
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified, " +
    "SUM(CASE WHEN status = 'consumed' THEN 1 ELSE 0 END) AS consumed, " +
    "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, " +
    "SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired, " +
    "SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded " +
    "FROM free_ticket_sessions WHERE event_id = ?", [id]);
  const claims = await dbGet(env,
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, " +
    "SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) AS released " +
    "FROM free_ticket_claims WHERE event_id = ?", [id]);
  const emails = await one("SELECT COUNT(DISTINCT email_hash) AS n FROM free_ticket_claims WHERE event_id = ? AND status = 'active'", [id]);
  const issued = await one("SELECT COALESCE(SUM(quantity),0) AS n FROM free_ticket_claims WHERE event_id = ? AND status = 'active'", [id]);
  const recentThrottles = await one(
    "SELECT COUNT(*) AS n FROM rate_limits WHERE action IN ('free_otp','free_verify','free_register') AND rate_key LIKE ?",
    ["%:e" + id]);
  const s = sessions || {}, c = claims || {};
  return {
    otp_requests: Number(s.total || 0),
    sessions_verified: Number(s.verified || 0),
    sessions_consumed: Number(s.consumed || 0),
    sessions_pending: Number(s.pending || 0),
    sessions_expired: Number(s.expired || 0),
    sessions_superseded: Number(s.superseded || 0),
    claims_active: Number(c.active || 0),
    claims_released: Number(c.released || 0),
    free_tickets_issued: issued,
    unique_verified_emails: emails,
    recent_ip_throttles: recentThrottles
  };
}

/* Data-retention sweep for the free-ticket tables. Called by the cron trigger,
   and opportunistically (at most once per isolate per 6 hours) from the
   verification request, so the tables stay small even without a cron:
     - sessions older than 7 days are removed (a code - verified or not - is
       useless long before that, and its continuation token has long expired);
     - 'released' claim rows older than 30 days are removed.
   ACTIVE claim rows are always KEPT: they are what enforces the per-email limit
   for a live event. force=true (the cron) skips the local throttle. */
const FREE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let freeLastSweep = 0;
function sqlStamp(ms){ return isoStamp(ms).replace("T", " ").slice(0, 19); }
async function freeTicketSweep(env, force){
  const now = Date.now();
  if(!force && now - freeLastSweep < FREE_SWEEP_INTERVAL_MS) return { skipped: true };
  if(!env || !env.DB) return { skipped: true };
  freeLastSweep = now;
  let sessions = 0, claims = 0;
  try {
    const a = await dbRun(env, "DELETE FROM free_ticket_sessions WHERE created_at <= ?", [sqlStamp(now - 7 * 24 * 60 * 60 * 1000)]);
    sessions = (a && a.meta && Number(a.meta.changes)) || 0;
  } catch(e){ /* pre-0006 database */ }
  try {
    const b = await dbRun(env, "DELETE FROM free_ticket_claims WHERE status = 'released' AND updated_at <= ?", [sqlStamp(now - 30 * 24 * 60 * 60 * 1000)]);
    claims = (b && b.meta && Number(b.meta.changes)) || 0;
  } catch(e){ /* pre-0006 database */ }
  return { sessions: sessions, claims: claims };
}

/* ============================================================================
   DIGITAL ORGANIZER AGREEMENT & PLATFORM FEE TERMS  (migration 0008)
   ----------------------------------------------------------------------------
   A signed agreement is now a PRECONDITION of publication. The rule is enforced
   here, in the Worker, and nowhere else: the browser is never trusted, and there
   is no administrative shortcut.

     1. Commercial terms live in platform_agreements. A version is created as a
        draft, reviewed, then activated; activating a version supersedes the
        previous one. Once a version has been accepted it is IMMUTABLE - a change
        to the fee terms means a NEW version.
     2. An organizer accepts a version once, through a single-use, time-limited,
        organizer-specific invitation (only the token HASH is stored). The
        signature row keeps the exact text and the exact fee configuration that
        was accepted, plus the UTC signing instant and a reference number.
     3. requireAgreementForPublish() is the ONE gate every publication path calls
        (organizer create, organizer update, owner approval, and anything added
        later). It fails closed: if the agreement state cannot be read, the
        publication is refused.

   WHAT THIS MODULE DOES NOT DO: it never changes an amount, an order or a
   payment row. platformFeeForAmount() exists so the accepted fee terms can be
   shown and computed server-side; deduction and settlement remain the separate,
   legally reviewed money flow they already were.
   ========================================================================== */
const AGREEMENT_STATUSES = ["draft", "active", "superseded", "archived"];
const AGREEMENT_SIGN_STATUSES = ["accepted", "revoked"];
const AGREEMENT_INVITE_STATUSES = ["pending", "used", "expired", "revoked"];
const AGREEMENT_INVITE_TTL_HOURS = 24;
const AGREEMENT_MIN_SIGNATORY = 3;
const AGREEMENT_MAX_SIGNATORY = 160;
const AGREEMENT_MAX_CONTENT = 120000;
const AGREEMENT_MAX_TITLE = 160;
const AGREEMENT_MAX_VERSION = 24;
const AGREEMENT_MAX_SUMMARY = 600;
const AGREEMENT_MAX_ROLE = 80;
const AGREEMENT_FEE_TEXT_MAX = 2000;
const AGREEMENT_PAGE = "/organizer-agreement/";
const AGREEMENT_ACCEPT_METHOD = "firebase_authenticated_email_and_single_use_token";
/* Free-text commercial clauses. Every one of them is optional, so a deployment
   only states the terms it actually uses. */
const AGREEMENT_FEE_TEXT_KEYS = ["payment_fees", "payout_terms", "refund_policy", "cancellation_policy",
  "chargeback_policy", "organizer_responsibilities", "tickethub_responsibilities", "termination_conditions",
  "effective_note"];

/* --------------------------------------------------- agreement formatting ----
   The agreement is a legal document, so formatting is part of it: headings, bold,
   italic, underline, lists and quotes must look identical in the owner's editor,
   in the organizer's review page, in the emailed summary and in the downloaded
   signed copy.

   The owner composes with a rich-text editor; the Worker NEVER trusts that HTML.
   Everything is reduced to a small allow-list here, at write time AND again at
   read/render time (defence in depth), so a script, an iframe, an on* handler, a
   style block or a javascript: link can never reach the organizer's browser, the
   R2 document or an email. Plain text is still accepted: it is escaped and shown
   as paragraphs exactly as before. */
const AGREEMENT_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "s", "h3", "h4", "h5",
  "ul", "ol", "li", "blockquote", "hr", "span", "a", "code", "mark", "small", "sup", "sub", "div", "span"];
/* Every tag the allow-list strips, escaped out before anything else runs, so a
   "</p><script>" style breakout cannot survive the first pass. */
const AGREEMENT_DROP_BLOCKS = /<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base|svg|math|template|noscript)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi;
function agreementSanitiseHtml(raw){
  let text = String(raw == null ? "" : raw);
  if(!text) return "";
  text = text.replace(/<!--[\s\S]*?-->/g, "");            // comments
  text = text.replace(AGREEMENT_DROP_BLOCKS, "");        // script/style/iframe/...
  text = text.replace(/<\s*(br|\/p|\/div|\/li|\/h[3-5]|\/ul|\/ol|\/blockquote|\/span|\/strong|\/b|\/em|\/i|\/u|\/s|\/small|\/code|\/mark|\/sup|\/sub|\/a)\s*\/?\s*>/gi, "\n");
  /* Allow-listed tags survive with their text; everything else is UNWRAPPED (the
     words stay, the tag goes) - stripping content would silently delete clauses. */
  text = text.replace(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?\s*>/g, function(match, tag, attrs){
    const name = String(tag).toLowerCase();
    if(AGREEMENT_TAGS.indexOf(name) === -1) return "";
    if(String(attrs).trim() === "") return "<" + name + ">";
    if(name !== "a") return "<" + name + ">";             // every other attribute is dropped
    const href = /(?:^|\s)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(attrs));
    const url = href ? String(href[2] !== undefined ? href[2] : (href[3] !== undefined ? href[3] : href[4]) || "").trim() : "";
    /* http(s) only: no javascript:, no data:, no protocol-relative surprises. */
    if(!/^https?:\/\/[A-Za-z0-9.\-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(url)) return "<a>";
    return '<a href="' + agreementDocEscape(url) + '" rel="noopener noreferrer">';
  });
  return text.trim();
}
/* Plain text becomes escaped paragraphs (the behaviour every existing version
   was written for); formatted text is rendered as the sanitised HTML it is. */
function agreementContentIsHtml(content){ return /<\s*(p|br|strong|b|em|i|u|s|h[3-5]|ul|ol|li|blockquote|div|span|a|hr)\b/i.test(String(content || "")); }
function agreementPlainText(content){
  return agreementDocEscape(String(content == null ? "" : content))
    .replace(/<\s*\/?\s*(p|div|li|h[3-5]|blockquote)\s*>/gi, "\n")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/?\s*[a-zA-Z][a-zA-Z0-9]*[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n");
}
function agreementContentHtml(content){
  const raw = String(content == null ? "" : content);
  if(!raw.trim()) return "<p class=\"empty\">No text has been provided for this version yet.</p>";
  if(!agreementContentIsHtml(raw)){
    return raw.split(/\r?\n/).map(line => line.trim() ? "<p>" + agreementDocEscape(line) + "</p>" : "").join("");
  }
  return agreementSanitiseHtml(raw);
}
function agreementContentFormat(content){ return agreementContentIsHtml(content) ? "html" : "text"; }
/* The ONE write path for agreement text. Rich text is reduced to the allow-list
   above, plain text is kept verbatim, and the visible words must still be
   substantial: a "version" made only of markup is refused, not stored. */
function agreementNormaliseContent(raw, required){
  const incoming = vStr(raw, "content", { max: AGREEMENT_MAX_CONTENT });
  const stored = agreementContentIsHtml(incoming) ? agreementSanitiseHtml(incoming) : incoming.trim();
  const words = agreementPlainText(stored).replace(/\s+/g, " ").trim();
  if(required && words.length < 20){
    throw err(422, "The agreement text is empty or too short for organizers to accept.", "VALIDATION");
  }
  return words ? stored : "";
}
/* ------------------------------------------------------------- time utils -- */
/* Stored timestamps are UTC "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now') and
   touch()), so they are normalised to ISO before parsing - never to local time. */
function agreementSqlStamp(ms){ return new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19); }
function agreementMs(value){
  const s = String(value == null ? "" : value).trim();
  if(!s) return 0;
  const iso = s.indexOf("T") > -1 ? s : s.replace(" ", "T");
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + "Z";
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : 0;
}
function agreementKeyMaterial(env){
  return String((env && (env.AGREEMENT_AUDIT_KEY || env.PAYMENT_ENCRYPTION_KEY || env.FREE_TICKET_OTP_KEY ||
    env.TURNSTILE_SECRET || env.TURNSTILE_SECRET_KEY)) || "tickethub-agreement-static");
}
/* Reference shown to the organizer and printed on the document. Not a secret:
   it identifies the record, not the person. */
function agreementReference(){
  return "AGR-" + new Date().getUTCFullYear() + "-" + randomCode(8);
}
function agreementPageUrl(env, request){ return appBase(env, request) + AGREEMENT_PAGE; }
function agreementReviewUrl(env, request, rawToken){
  return agreementPageUrl(env, request) + "?token=" + encodeURIComponent(String(rawToken || ""));
}
/* Signing tokens are 32 random bytes as base64url: 43 characters from a fixed
   alphabet. Generating and validating them the same way means a mangled or
   hand-edited link (a stray "undefined" pasted into the URL, a truncated copy) is
   refused as invalid immediately, instead of silently hashing something nobody
   can ever match. */
function agreementNewToken(){
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}
function agreementTokenLooksValid(token){
  return /^[A-Za-z0-9_-]{43}$/.test(String(token == null ? "" : token));
}


/* ------------------------------------------------------- fee configuration ---
   The commercial terms of a version, validated and clamped server-side. Nothing
   is invented here: an absent field is simply absent, and the review page shows
   only what the owner actually configured. */
function agreementFeeConfig(raw){
  let source = raw;
  if(typeof source === "string"){
    const text = source.trim();
    if(!text){ source = {}; }
    else {
      try { source = JSON.parse(text); }
      catch(e){ throw err(422, "The fee configuration must be a valid JSON object.", "VALIDATION"); }
    }
  }
  if(source == null) source = {};
  if(typeof source !== "object" || Array.isArray(source)) throw err(422, "The fee configuration must be a JSON object.", "VALIDATION");
  const out = {};
  const num = (value, label, min, max, whole) => {
    if(value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if(!Number.isFinite(n)) throw err(422, label + " must be a number.", "VALIDATION");
    if(whole && !Number.isInteger(n)) throw err(422, label + " must be a whole number.", "VALIDATION");
    if(n < min || n > max) throw err(422, label + " must be between " + min + " and " + max + ".", "VALIDATION");
    return whole ? n : Math.round(n * 1000) / 1000;
  };
  const pct = num(source.commission_percent, "Platform commission percentage", 0, 100, false);
  if(pct != null) out.commission_percent = pct;
  const fixed = num(source.commission_fixed, "Fixed platform fee", 0, 100000000, true);
  if(fixed != null) out.commission_fixed = fixed;
  if(source.commission_basis !== undefined && source.commission_basis !== null && source.commission_basis !== ""){
    const basis = vStr(source.commission_basis, "commission basis", { max: 40 }).toLowerCase();
    if(["ticket_subtotal", "order_total", "per_ticket"].indexOf(basis) < 0){
      throw err(422, "Commission basis must be one of ticket_subtotal, order_total or per_ticket.", "VALIDATION");
    }
    out.commission_basis = basis;
  }
  for(const key of AGREEMENT_FEE_TEXT_KEYS){
    const rawText = source[key];
    if(rawText === undefined || rawText === null) continue;
    const text = vStr(rawText, key.replace(/_/g, " "), { max: AGREEMENT_FEE_TEXT_MAX });
    if(text) out[key] = text;
  }
  return { value: out, json: JSON.stringify(out) };
}
/* Server-side computation of the platform fee for an amount, using the fee
   configuration that applies. Display/reporting only - it never rewrites an
   order total, and it is not part of the payment flow. */
function platformFeeForAmount(fee, amount){
  const f = (fee && typeof fee === "object") ? fee : {};
  const base = Math.max(0, Math.round(Number(amount) || 0));
  const pct = Math.max(0, Math.min(100, Number(f.commission_percent) || 0));
  const fixed = Math.max(0, Math.round(Number(f.commission_fixed) || 0));
  const commission = Math.round(base * pct / 100);
  const total = Math.min(base, commission + fixed);
  return { base_amount: base, commission_percent: pct, commission_amount: commission,
    fixed_fee: fixed, platform_fee: total, organizer_net: Math.max(0, base - total), basis: f.commission_basis || "order_total" };
}
function agreementFeeView(agreement){
  let fee = {};
  try { fee = JSON.parse((agreement && agreement.fee_config_json) || "{}") || {}; } catch(e){ fee = {}; }
  const rows = [];
  if(fee.commission_percent != null) rows.push({ label: "Platform commission", value: String(fee.commission_percent) + "% of the ticket subtotal" });
  if(fee.commission_fixed != null && Number(fee.commission_fixed) > 0) rows.push({ label: "Fixed platform fee", value: "KSh " + Number(fee.commission_fixed).toLocaleString("en-KE") + " per order" });
  if(fee.commission_basis) rows.push({ label: "Commission basis", value: String(fee.commission_basis) });
  const texts = { payment_fees: "Payment processing fees", payout_terms: "Payout terms", refund_policy: "Refunds",
    cancellation_policy: "Cancellation", chargeback_policy: "Chargebacks and disputes",
    organizer_responsibilities: "Organizer responsibilities", tickethub_responsibilities: "TicketHub responsibilities",
    termination_conditions: "Termination", effective_note: "Notes" };
  for(const key of Object.keys(texts)) if(fee[key]) rows.push({ label: texts[key], value: String(fee[key]) });
  return { config: fee, rows: rows, example: platformFeeForAmount(fee, 1000) };
}


/* ------------------------------------------------------------ audit trail --- */
/* Only a hash of the client IP is stored, plus a truncated user agent, and both
   only where they have evidentiary value (signing, publishing blocks). The audit
   table is written by the Worker alone: no organizer route updates or deletes a
   row, so ordinary organizers cannot alter the trail. */
async function agreementAudit(env, request, entry){
  const o = entry || {};
  try {
    let ipHash = null;
    if(request){
      const ip = normaliseIp(clientIp(request));
      if(ip && ip !== "unknown") ipHash = (await hmacSha256Hex(agreementKeyMaterial(env), "agreement-ip|" + ip)).slice(0, 48);
    }
    const ua = request ? String(request.headers.get("User-Agent") || "").slice(0, 180) : null;
    await dbRun(env,
      "INSERT INTO agreement_audit_log (action, agreement_id, agreement_version, organizer_id, actor_user_id, actor_role, subject_user_id, detail_json, ip_hash, user_agent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [String(o.action || "unknown").slice(0, 60), o.agreement_id || null, o.agreement_version || null,
       o.organizer_id || null, o.actor_user_id || null, o.actor_role || null, o.subject_user_id || null,
       o.detail ? JSON.stringify(o.detail).slice(0, 2000) : null, ipHash, ua, touch()]);
    return true;
  } catch(e){
    /* An audit failure must never break the business action it describes, but it
       must be visible to operations. No personal data is written to the log. */
    console.error("AGREEMENT_AUDIT_FAILED", String((e && e.message) || e));
    return false;
  }
}

/* --------------------------------------------------- reading + sign state --- */
async function activeAgreement(env){
  return dbGet(env, "SELECT * FROM platform_agreements WHERE status = 'active' ORDER BY id DESC LIMIT 1", []);
}
async function agreementById(env, id){
  if(!id) return null;
  return dbGet(env, "SELECT * FROM platform_agreements WHERE id = ?", [id]);
}
async function agreementSignatureFor(env, organizerId, agreementId){
  if(!organizerId || !agreementId) return null;
  return dbGet(env, "SELECT * FROM organizer_agreements WHERE organizer_id = ? AND agreement_id = ? AND status = 'accepted'", [organizerId, agreementId]);
}
async function latestAgreementSignature(env, organizerId){
  if(!organizerId) return null;
  return dbGet(env, "SELECT * FROM organizer_agreements WHERE organizer_id = ? ORDER BY id DESC LIMIT 1", [organizerId]);
}
/* The single source of truth for "may this organizer publish?".
     status: signed | pending | outdated | revoked | not_configured
   FAIL CLOSED: a missing active version, an unreadable signature or a database
   error all leave required === true. */
async function agreementStateFor(env, organizerId){
  const active = await activeAgreement(env);
  const latest = await latestAgreementSignature(env, organizerId);
  const state = {
    active: active, signature: null, latest: latest,
    version: active ? active.version : null,
    signed_version: latest ? latest.agreement_version : null,
    status: "signed", required: false, can_publish: true
  };
  if(!active){
    state.status = "not_configured";
    state.required = true;
    state.can_publish = false;
    return state;
  }
  const signed = await agreementSignatureFor(env, organizerId, active.id);
  if(signed){
    state.signature = signed;
    return state;
  }
  state.required = true;
  state.can_publish = false;
  if(latest && Number(latest.agreement_id) === Number(active.id) && String(latest.status) === "revoked") state.status = "revoked";
  else if(latest && String(latest.status) === "accepted") state.status = "outdated";
  else state.status = "pending";
  return state;
}
function agreementStateUserMessage(state){
  const version = state && state.version ? (" (v" + state.version + ")") : "";
  if(!state || state.status === "not_configured"){
    return "Publishing is paused because the " + API_NAME.replace(" API", "") + " organizer agreement is not available yet. Please contact support.";
  }
  if(state.status === "pending"){
    return "You must review and sign the organizer agreement" + version + " before an event can be published. Open your agreement page to sign it.";
  }
  if(state.status === "outdated"){
    return "A newer organizer agreement" + version + " must be reviewed and accepted before you can publish your next event. Your already-published events keep their existing terms.";
  }
  if(state.status === "revoked"){
    return "Your accepted organizer agreement has been withdrawn, so publishing is paused. Please contact support and then accept the agreement again.";
  }
  return "Review and sign the organizer agreement before an event can be published.";
}
function agreementStatusPayload(state){
  if(!state) return { status: "unknown", required: true, can_publish: false };
  return {
    status: state.status,
    required: !!state.required,
    can_publish: !!state.can_publish,
    active_version: state.version,
    signed_version: state.signed_version,
    signed_at: state.signature ? state.signature.accepted_at : (state.latest ? state.latest.accepted_at : null),
    reference: state.signature ? state.signature.reference : (state.latest ? state.latest.reference : null),
    status_message: state.required ? agreementStateUserMessage(state) : "Your organizer agreement is signed and up to date.",
    agreement_url: AGREEMENT_PAGE
  };
}


/* ============================================================================
   THE PUBLICATION GATE
   ----------------------------------------------------------------------------
   Every path that can make an event publicly available funnels through this one
   function. It is called with the organizer that OWNS the event, so an owner or
   support account cannot publish someone else's unsigned event either.

   Returns the agreement state on success; throws a 403 AGREEMENT_REQUIRED (plus
   machine-readable fields the dashboard can act on) when the signature is
   missing, outdated or unverifiable.
   ========================================================================== */
async function requireAgreementForPublish(env, request, organizerId, opts){
  const o = opts || {};
  const state = await agreementStateFor(env, organizerId);
  if(!state.required) return state;
  const failure = err(403, agreementStateUserMessage(state), "AGREEMENT_REQUIRED");
  failure.details = {
    agreement_required: true,
    agreement_status: state.status,
    agreement_version: state.version,
    signed_version: state.signed_version,
    agreement_url: AGREEMENT_PAGE,
    publication_blocked: true,
    blocked_path: o.source || null
  };
  securityLog("agreement_publish_blocked", request, {
    organizer_id: organizerId, agreement_status: state.status,
    agreement_version: state.version, source: o.source || null, event_id: o.event_id || null
  });
  await agreementAudit(env, request, {
    action: "publication_blocked", organizer_id: organizerId,
    agreement_id: state.active ? state.active.id : null, agreement_version: state.version,
    actor_user_id: o.actor_user_id || null, actor_role: o.actor_role || null,
    detail: { source: o.source || null, event_id: o.event_id || null, reason: state.status }
  });
  throw failure;
}
/* Records which agreement version governed an event when it was published. The
   snapshot keeps a published event on its original terms: a later version never
   rewrites what an event was already published under. */
async function stampEventAgreement(env, eventId, state){
  if(!eventId || !state || !state.active) return;
  try {
    await dbRun(env, "UPDATE events SET agreement_id = ?, agreement_version = ?, updated_at = ? WHERE id = ? AND (agreement_id IS NULL OR agreement_id <> ?)",
      [state.active.id, state.active.version, touch(), eventId, state.active.id]);
  } catch(e){
    /* A pre-0008 database: the event still publishes under the accepted terms,
       it simply cannot record the version number yet. */
    console.error("AGREEMENT_STAMP_FAILED", String((e && e.message) || e));
  }
}

/* ------------------------------------------------------- email link bundle -- */
/* Same shape as emailLinks() so link harvesting works unchanged, with the
   agreement_review link (carrying the one-time token) layered on top per email. */
function agreementEmailLinks(env, request, reviewUrl){
  const base = appBase(env, request);
  const page = (name) => (base ? base + "/" + name : "");
  return {
    base: base,
    home: page(""),
    events: page("events/"),
    contact: page("contact/"),
    support: page("contact/"),
    terms: page("terms/"),
    privacy: page("privacy/"),
    organizer: page("organizer-dashboard/"),
    create_event: page("create-event/"),
    owner: page("owner-dashboard/"),
    owner_events: page("owner-events/"),
    agreement: page("organizer-agreement/"),
    agreement_review: reviewUrl || page("organizer-agreement/"),
    ticket_base: page("ticket/?ticket=")
  };
}
function agreementEmailPayload(env, request, opts){
  const o = opts || {};
  const ag = o.agreement || {};
  const base = appBase(env, request);
  return {
    agreement: {
      id: ag.id || null,
      title: ag.title || "Organizer Agreement",
      version: ag.version || null,
      previous_version: o.previous_version || null,
      effective_date: ag.effective_date || null,
      summary: o.summary || ag.summary || null,
      expires_at: o.expires_at || null,
      reference: o.reference || null,
      signatory_name: o.signatory_name || null,
      signatory_email: o.signatory_email || null,
      signed_at: o.signed_at || null,
      fee_config: o.fee_config || null
    },
    links: agreementEmailLinks(env, request, o.review_url),
    organizer_agreement_page: base + AGREEMENT_PAGE,
    customer: { name: o.name || "", email: o.email || "" }
  };
}


/* --------------------------------------------------- signed document (R2) --- */
/* The stored document reproduces the exact text and fee terms the organizer
   accepted, in a self-contained, print-ready HTML file. It is NOT placed under
   the public /media/ prefix and its key never appears in a public response, so
   no signed contract containing personal information is publicly readable. */
function agreementDocKey(organizerId, reference){ return "agreements/" + Number(organizerId) + "/" + String(reference) + ".html"; }
function agreementDocEscape(value){
  return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function agreementDocFeeHtml(feeView){
  if(!feeView || !feeView.rows.length) return "<p>No separate platform fee terms were configured for this version.</p>";
  return "<table class=\"fee\"><tbody>" + feeView.rows.map(r =>
    "<tr><th>" + agreementDocEscape(r.label) + "</th><td>" + agreementDocEscape(r.value) + "</td></tr>").join("") + "</tbody></table>";
}
function agreementDocumentHtml(o){
  const signature = o.signature || {}, agreement = o.agreement || {}, org = o.organizer || {}, user = o.user || {};
  const content = String(o.content || signature.content_snapshot || agreement.content || "");
  /* The agreed terms are printed EXACTLY as the organizer saw them: the same
     sanitised HTML, with a small print stylesheet inlined so the downloaded file
     is self-contained and keeps every heading, bold, italic and underline. */
  const body = agreementContentHtml(content);
  const brandName = (o.brand && o.brand.product) || API_NAME.replace(" API", "");
  const parent = (o.brand && o.brand.parent) || "";
  const support = (o.brand && (o.brand.support_email || o.brand.support_phone)) || "";
  const metaRow = (label, value) => "<tr><th>" + agreementDocEscape(label) + "</th><td>" + agreementDocEscape(value) + "</td></tr>";
  return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\" />" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />" +
    "<title>" + agreementDocEscape((agreement.title || "Organizer Agreement") + " - " + signature.reference) + "</title>" +
    "<style>body{font-family:Georgia,'Times New Roman',serif;color:#111;margin:0;background:#f4f5f8}" +
    "main{max-width:820px;margin:0 auto;background:#fff;padding:48px 44px}" +
    "h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;margin:32px 0 10px;border-bottom:1px solid #ddd;padding-bottom:6px}" +
    "p{margin:0 0 10px;line-height:1.65;font-size:14px;white-space:pre-wrap}" +
    /* formatting of the agreement text, printed exactly as agreed */
    "main h3{font-size:16px;margin:22px 0 8px;letter-spacing:-.01em}main h4{font-size:14.5px;margin:18px 0 6px}" +
    "main h5{font-size:13.5px;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.06em;color:#333}" +
    "main strong{font-weight:700}main em{font-style:italic}main u{text-decoration:underline}" +
    "main ul,main ol{margin:0 0 12px;padding-left:22px}main li{margin:0 0 6px}" +
    "main blockquote{margin:0 0 12px;padding:8px 14px;border-left:3px solid #bbb;color:#333;font-style:italic}" +
    "main hr{border:0;border-top:1px solid #ddd;margin:18px 0}" +
    "main a{color:#1D4ED8;text-decoration:underline;word-break:break-word}" +
    "main code{font-family:Consolas,monospace;font-size:12.5px;background:#F4F4F7;padding:1px 4px;border-radius:4px}" +
    "main mark{background:#FFF3A3}" +
    "main p.empty{color:#777;font-style:italic}" +
    "table.fee,table.meta{width:100%;border-collapse:collapse;font-size:14px}" +
    "table.fee th,table.fee td{border:1px solid #ddd;padding:8px 10px;text-align:left;vertical-align:top}" +
    "table.fee th{background:#f7f7fa;width:34%;font-weight:600}" +
    "table.meta th{text-align:left;width:34%;padding:6px 8px 6px 0;color:#555;font-weight:600;vertical-align:top}" +
    "table.meta td{padding:6px 0}" +
    ".signature-mark{margin:22px 0 8px;padding:12px;border:1px solid #ddd;max-width:420px}" +
    ".signature-mark img{display:block;width:100%;height:100px;object-fit:contain;object-position:left center}" +
    ".hash{font-family:Consolas,monospace;font-size:11px;word-break:break-all;color:#444}" +
    ".note{font-size:12px;color:#555;border-top:1px solid #eee;margin-top:28px;padding-top:14px}" +
    ".toolbar{max-width:820px;margin:16px auto 0;text-align:right}" +
    "@media print{body{background:#fff}main{padding:0}.toolbar{display:none}}" +
    "</style></head><body>" +
    '<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>' +
    "<main><h1>" + agreementDocEscape(agreement.title || "Organizer Agreement") + "</h1>" +
    "<div><strong>Version " + agreementDocEscape(agreement.version || "-") + "</strong> &middot; " + agreementDocEscape(brandName) + "</div>" +
    "<h2>Parties and record</h2><table class=\"meta\"><tbody>" +
    metaRow("Organizer", org.business_name || user.full_name || "-") +
    metaRow("Organizer email", org.business_email || user.email || signature.signatory_email || "-") +
    metaRow("Signatory (full legal name)", signature.signatory_name || "-") +
    metaRow("Capacity", signature.signatory_role || "Authorised representative") +
    metaRow("Agreement reference", signature.reference || "-") +
    metaRow("Version", signature.agreement_version || agreement.version || "-") +
    metaRow("Effective date", agreement.effective_date || "On acceptance") +
    metaRow("Signed at (UTC)", signature.accepted_at || "-") +
    metaRow("Acceptance method", signature.verification_method || AGREEMENT_ACCEPT_METHOD) +
    "<tr><th>Document hash (SHA-256)</th><td class=\"hash\">" + agreementDocEscape(o.sha256 || "") + "</td></tr>" +
    "</tbody></table>" +
    "<h2>Organizer handwritten signature</h2>" +
    (signature.signature_image ? "<div class=\"signature-mark\"><img alt=\"Organizer handwritten signature\" src=\"" + agreementDocEscape(signature.signature_image) + "\"></div>" : "<p>Handwritten signature not recorded.</p>") +
    "<h2>Platform fee terms accepted</h2>" + agreementDocFeeHtml(o.fee_view) +
    "<h2>Agreement terms as accepted</h2>" + body +
    "<div class=\"note\">This document reproduces the agreement text and platform fee configuration that were in force and accepted by the " +
    "signatory above at the UTC time shown. Acceptance used the signatory's authenticated " + agreementDocEscape(brandName) +
    " account together with a single-use, time-limited signing link; the electronic acceptance is recorded in the platform database together " +
    "with the agreement reference and the hash above. " + (support ? ("Contact: " + agreementDocEscape(support) + ". ") : "") +
    (parent ? (parent + ". ") : "") + "Generated " + agreementDocEscape(touch()) + " UTC.</div>" +
    "</main></body></html>";
}

/* Best-effort: the signature row is already stored when this runs, so a storage
   failure is recorded and retried, never reported as a completed document. */
async function agreementStoreDocument(env, signature, html){
  const sha256 = await sha256Hex(html);
  let key = null;
  if(env.BUCKET && typeof env.BUCKET.put === "function"){
    try {
      key = agreementDocKey(signature.organizer_id, signature.reference);
      await env.BUCKET.put(key, utf8(html), { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    } catch(e){
      key = null;
      console.error("AGREEMENT_DOC_STORE_FAILED", String((e && e.message) || e));
    }
  }
  try {
    await dbRun(env, "UPDATE organizer_agreements SET document_key = ?, document_sha256 = ? WHERE id = ?", [key, sha256, signature.id]);
  } catch(e){ /* pre-0008 columns absent: the hash is still returned to the caller */ }
  return { key: key, sha256: sha256, stored: !!key };
}

/* --------------------------------------------------------- invitations ------
   One-time, 24-hour, organizer-specific signing token. Only the SHA-256 hash is
   persisted, so a database dump never exposes a usable signing link, and the
   token is consumed atomically (WHERE status='pending') so a double submit
   cannot record two signatures. */
async function agreementIssueInvite(env, request, opts){
  const o = opts || {};
  const agreement = o.agreement;
  const user = o.user;
  if(!agreement || !user) throw err(400, "An agreement version and organizer are required.", "VALIDATION");
  const raw = agreementNewToken();
  const hash = await sha256Hex(raw);
  const now = Date.now();
  const expires = now + AGREEMENT_INVITE_TTL_HOURS * 60 * 60 * 1000;
  const invitation = {
    agreement_id: agreement.id,
    organizer_id: Number(user.organizer_id) || null,
    user_id: user.id || null,
    email: normaliseEmail(user.email),
    token_hash: hash,
    issued_by: o.actor_user_id || user.id || null,
    issued_by_role: o.actor_role || "owner",
    expires_at: agreementSqlStamp(expires),
    status: "pending",
    created_at: agreementSqlStamp(now)
  };
  /* A pending invitation is replaced rather than accumulated, so a re-issue
     cannot leave several live links for the same organizer and version. */
  try {
    await dbRun(env, "UPDATE agreement_invitations SET status = 'revoked' WHERE status = 'pending' AND agreement_id = ? AND user_id = ?",
      [invitation.agreement_id, invitation.user_id]);
  } catch(e){ /* pre-0008 database */ }
  const res = await dbRun(env,
    "INSERT INTO agreement_invitations (agreement_id, organizer_id, user_id, email, token_hash, issued_by, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [invitation.agreement_id, invitation.organizer_id, invitation.user_id, invitation.email, invitation.token_hash,
     invitation.issued_by, "pending", invitation.created_at, invitation.expires_at]);
  invitation.id = (res && res.meta && res.meta.last_row_id) || null;
  await agreementAudit(env, request, {
    action: "invitation_issued", agreement_id: agreement.id, agreement_version: agreement.version,
    organizer_id: invitation.organizer_id, actor_user_id: invitation.issued_by,
    actor_role: invitation.issued_by_role, subject_user_id: invitation.user_id,
    detail: { invitation_id: invitation.id, expires_at: invitation.expires_at, email: invitation.email }
  });
  return { invitation: invitation, raw_token: raw, review_url: agreementReviewUrl(env, request, raw) };
}
/* Accepts the RAW token: selects its record, enforces every condition, then
   consumes it atomically (status='pending' guard) so a double submit or a
   concurrent request can never record two signatures. Returns null when the
   token cannot be consumed. */
async function agreementConsumeInvite(env, rawToken){
  const hash = await sha256Hex(String(rawToken || ""));
  const nowStamp = agreementSqlStamp(Date.now());
  const row = await dbGet(env, "SELECT * FROM agreement_invitations WHERE token_hash = ?", [hash]);
  if(!row) return null;
  if(String(row.status) !== "pending") return null;
  if(agreementMs(row.expires_at) <= Date.now()) return null;
  const res = await dbRun(env,
    "UPDATE agreement_invitations SET status='used', used_at=? WHERE id=? AND status='pending' AND token_hash=?",
    [nowStamp, row.id, hash]);
  const changed = Number((res && res.meta && res.meta.changes) || 0);
  if(changed !== 1) return null;
  return Object.assign({}, row, { status: "used", used_at: nowStamp });
}
async function agreementLookupInvite(env, rawToken){
  /* Reject a malformed token before it reaches the database: it can never match,
     and saying so plainly is what a half-copied link deserves. */
  if(!agreementTokenLooksValid(rawToken)) return { ok: false, reason: "invalid" };
  const hash = await sha256Hex(String(rawToken));
  const row = await dbGet(env, "SELECT * FROM agreement_invitations WHERE token_hash = ?", [hash]);
  if(!row) return { ok: false, reason: "invalid" };
  if(String(row.status) === "used") return { ok: false, reason: "used", row: row };
  if(String(row.status) !== "pending") return { ok: false, reason: String(row.status), row: row };
  if(agreementMs(row.expires_at) <= Date.now()) return { ok: false, reason: "expired", row: row };
  return { ok: true, row: row };
}


/* --------------------------------------------------- agreement route views -- */
function agreementVersionView(a){
  if(!a) return null;
  return { id: a.id, version: a.version, title: a.title, summary: a.summary || null,
    effective_date: a.effective_date || null, status: a.status,
    created_at: a.created_at || null, activated_at: a.activated_at || null };
}
function agreementSignatureView(s){
  if(!s) return null;
  return { reference: s.reference, agreement_id: s.agreement_id, agreement_version: s.agreement_version,
    signatory_name: s.signatory_name, signatory_email: s.signatory_email, signatory_role: s.signatory_role,
    status: s.status, accepted_at: s.accepted_at, verification_method: s.verification_method,
    document_ready: !!s.document_key, confirmation_email_status: s.confirmation_email_status || null };
}
/* One place that turns an invitation failure into the HTTP answer, so the
   verify and sign routes say exactly the same thing. */
function agreementLinkError(reason){
  const map = {
    invalid: [404, "This signing link is not valid. Open the link from your most recent agreement email, or request a new one.", "AGREEMENT_LINK_INVALID"],
    used:    [409, "This signing link has already been used. Open your agreement page to check your status.", "AGREEMENT_LINK_USED"],
    expired: [410, "This signing link has expired. Request a new one from your agreement page.", "AGREEMENT_LINK_EXPIRED"],
    revoked: [409, "This signing link was replaced by a newer one. Use the most recent link you were sent.", "AGREEMENT_LINK_REVOKED"]
  };
  const hit = map[reason] || map.invalid;
  return err(hit[0], hit[1], hit[2]);
}
/* --------------------------------------------------------- agreement emails -- */
async function agreementSend(env, request, task, opts){
  const o = opts || {};
  try {
    const to = emailRecipient(o.to);
    if(!to || !o.template) return { queued: false, skipped: "no_recipient" };
    const result = await queueEmail(env, {
      to: to, to_name: o.to_name || "", template: o.template,
      dedupe_key: o.dedupe_key || undefined,
      payload: await agreementEmailPayload(env, request, Object.assign({ brand: await emailBrandFor(env) }, o.payload || {}))
    });
    if(result && result.queued) await dispatchSoon(env, task, 4);
    return result;
  } catch(e){
    console.error("EMAIL_AGREEMENT_ERROR", o.template || "-", String((e && e.message) || e));
    return { queued: false, skipped: "error" };
  }
}

/* ============================================================ ORGANIZER ROUTES */
/* GET /api/organizer/agreement  (+ /status) - what the dashboard banner, the
   settings page and the review page all read. */
async function routeOrganizerAgreement(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url, cors = corsFor(env, request);
  const session = await requireOrganizer(env, request);
  if(!session.org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const full = !/\/status$/.test(url.pathname);
  const state = await agreementStateFor(env, session.org.id);
  const active = state.active;
  const invite = await dbGet(env,
    "SELECT id, email, expires_at, status, agreement_id FROM agreement_invitations WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [session.user.id]);
  const payload = {
    state: agreementStatusPayload(state),
    agreement: agreementVersionView(active),
    signature: agreementSignatureView(state.signature || state.latest),
    invitation: invite ? { email: invite.email, expires_at: invite.expires_at,
      matches_active: active ? Number(invite.agreement_id) === Number(active.id) : false } : null,
    organizer: { id: session.org.id, business_name: session.org.business_name || null,
      email: session.org.business_email || session.user.email }
  };
  if(full){
    payload.content = active ? agreementContentHtml(active.content) : null;
    payload.content_format = active ? agreementContentFormat(active.content) : "text";
    payload.content_plain = active ? agreementPlainText(active.content) : null;
    payload.fee = active ? agreementFeeView(active) : null;
  }
  return ok(payload, cors);
}

/* POST /api/organizer/agreement/invite
   Creates a fresh single-use 24h signing link for THIS organizer and emails it.
   The link is also returned so the dashboard can open the review page straight
   away without waiting for the email. Re-issuing revokes the previous link. */
async function routeOrganizerAgreementInvite(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const session = await requireOrganizer(env, request);
  if(!session.org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  if(session.user.role === "event_staff") throw err(403, "Only the account owner can sign the organizer agreement.", "FORBIDDEN");
  await guardRate(env, request, "agreement_invite", { uid: await callerUid(env, request), email: session.user.email });
  const state = await agreementStateFor(env, session.org.id);
  if(!state.active) throw err(409, agreementStateUserMessage(state), "AGREEMENT_NOT_CONFIGURED");
  if(!state.required){
    return ok({ state: agreementStatusPayload(state), message: "Your organizer agreement is already signed and up to date." }, cors);
  }
  const issued = await agreementIssueInvite(env, request, {
    agreement: state.active,
    user: Object.assign({}, session.user, { organizer_id: session.org.id }),
    actor_user_id: session.user.id, actor_role: session.user.role
  });
  await agreementSend(env, request, ctx.ctx, {
    to: issued.invitation.email, to_name: session.user.full_name || "",
    template: "organizer_agreement_invitation",
    dedupe_key: "agreement_invitation:" + state.active.id + ":" + session.user.id + ":" + issued.invitation.id,
    payload: {
      agreement: { id: state.active.id, title: state.active.title, version: state.active.version,
        effective_date: state.active.effective_date, summary: state.active.summary,
        expires_at: issued.invitation.expires_at,
        fee_config: agreementFeeView(state.active).config },
      review_url: issued.review_url,
      signatory_name: session.user.full_name || "", signatory_email: issued.invitation.email,
      name: session.user.full_name || "", email: issued.invitation.email
    }
  });
  return ok({
    state: agreementStatusPayload(state),
    email: issued.invitation.email,
    expires_at: issued.invitation.expires_at,
    review_url: issued.review_url,
    message: "Your signing link is ready and was emailed to " + issued.invitation.email +
      ". It expires in " + AGREEMENT_INVITE_TTL_HOURS + " hours."
  }, cors);
}
/* GET /api/organizer/agreement/verify?token=...
   The review page loads the exact text and fee terms behind the link before
   anything can be signed. No token value is ever stored or logged. */
async function routeOrganizerAgreementVerify(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url, cors = corsFor(env, request);
  const session = await requireOrganizer(env, request);
  if(!session.org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const token = vStr(url.searchParams.get("token"), "token", { max: 200 });
  if(!token) throw err(400, "The signing link is missing its token. Request a new one.", "VALIDATION");
  const check = await agreementLookupInvite(env, token);
  if(!check.ok) throw agreementLinkError(check.reason);
  const invite = check.row;
  if(Number(invite.user_id) !== Number(session.user.id) || Number(invite.organizer_id) !== Number(session.org.id)){
    throw err(403, "This signing link was issued to a different account. Sign in as the invited organizer.", "FORBIDDEN");
  }
  const agreement = await agreementById(env, invite.agreement_id);
  if(!agreement || agreement.status !== "active"){
    throw err(409, "This invitation refers to an agreement version that is no longer active. Open your agreement page for the current version.", "AGREEMENT_OUTDATED");
  }
  const state = await agreementStateFor(env, session.org.id);
  await agreementAudit(env, request, {
    action: "agreement_viewed", agreement_id: agreement.id, agreement_version: agreement.version,
    organizer_id: session.org.id, actor_user_id: session.user.id, actor_role: session.user.role,
    detail: { invitation_id: invite.id, via: "signing_link" }
  });
  return ok({
    state: agreementStatusPayload(state),
    agreement: agreementVersionView(agreement),
    content: agreementContentHtml(agreement.content),
    content_format: agreementContentFormat(agreement.content),
    content_plain: agreementPlainText(agreement.content),
    fee: agreementFeeView(agreement),
    invitation: { email: invite.email, expires_at: invite.expires_at },
    signatory: { name: session.user.full_name || "", email: session.user.email, role: session.user.role }
  }, cors);
}

/* POST /api/organizer/agreement/sign
   THE signature. Requirements, all enforced here:
     - the caller is authenticated and owns the organizer profile
     - the single-use invitation is valid, belongs to this user AND this
       organizer, and targets the CURRENT active version
     - the exact terms being accepted are snapshotted on the row itself, so a
       later edit to the version cannot rewrite what was agreed
   The token is looked up and authorised BEFORE it is consumed, so a wrong
   account can never burn someone else's link. */
async function routeOrganizerAgreementSign(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const session = await requireOrganizer(env, request);
  if(!session.org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  if(session.user.role === "event_staff") throw err(403, "Only the account owner can sign the organizer agreement.", "FORBIDDEN");
  await guardRate(env, request, "agreement_sign", { uid: await callerUid(env, request), email: session.user.email });
  const body = await readJson(request);
  const token = vStr(body.token, "token", { max: 200 });
  const signatoryName = vStr(body.signatory_name, "full legal name", { max: AGREEMENT_MAX_SIGNATORY });
  const signatoryRole = vStr(body.signatory_role, "capacity", { max: AGREEMENT_MAX_ROLE });
  const agreed = body.agreed === true || body.agreed === 1 || body.agreed === "true";
  const signatureImage = String(body.signature_image || "");
  if(!token) throw err(400, "Your signing link is missing. Request a new one from the agreement page.", "VALIDATION");
  if(!signatoryName || signatoryName.length < AGREEMENT_MIN_SIGNATORY){
    throw err(422, "Type your full legal name exactly as it appears on your identification.", "VALIDATION");
  }
  if(!agreed) throw err(422, "You must confirm that you have read and accept the agreement.", "VALIDATION");
  const active = await activeAgreement(env);
  if(!active) throw err(409, agreementStateUserMessage({ status: "not_configured" }), "AGREEMENT_NOT_CONFIGURED");
  const check = await agreementLookupInvite(env, token);
  if(!check.ok) throw agreementLinkError(check.reason);
  const invite = check.row;
  if(Number(invite.user_id) !== Number(session.user.id) || Number(invite.organizer_id) !== Number(session.org.id)){
    throw err(403, "This signing link was issued to a different account. Sign in as the invited organizer.", "FORBIDDEN");
  }
  if(Number(invite.agreement_id) !== Number(active.id)){
    throw err(409, "This invitation is for an older version of the agreement. Request a new link for the current version.", "AGREEMENT_OUTDATED");
  }
  /* Already signed? A page reload or a double submit must be harmless. */
  const already = await agreementSignatureFor(env, session.org.id, active.id);
  if(already){
    return created({ signature: agreementSignatureView(already),
      state: agreementStatusPayload(await agreementStateFor(env, session.org.id)),
      already_signed: true, message: "You have already signed this version of the agreement." }, cors);
  }
  if(signatureImage.length > 150000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(signatureImage)){
    throw err(422, "Draw your handwritten signature before signing.", "VALIDATION");
  }
  const consumed = await agreementConsumeInvite(env, token);
  if(!consumed) throw err(409, "This signing link was just used or has expired. Request a new one.", "AGREEMENT_LINK_USED");
  const reference = agreementReference();
  const acceptedAt = touch();
  let ipHash = null;
  try {
    const ip = normaliseIp(clientIp(request));
    if(ip && ip !== "unknown") ipHash = (await hmacSha256Hex(agreementKeyMaterial(env), "agreement-sign|" + ip)).slice(0, 48);
  } catch(e){ /* evidentiary only */ }
  const evidence = JSON.stringify({
    invitation_id: invite.id, ip_hash: ipHash,
    user_agent: String(request.headers.get("User-Agent") || "").slice(0, 180)
  }).slice(0, 2000);
  const signatoryEmail = normaliseEmail(session.user.email);
  let sig = null;
  try {
    const ins = await dbRun(env,
      "INSERT INTO organizer_agreements (organizer_id, user_id, agreement_id, agreement_version, signatory_name, signatory_email, signatory_role, signature_image, status, accepted_at, content_snapshot, fee_snapshot_json, reference, verification_method, evidence_json, invitation_id, confirmation_email_status, created_at) VALUES (?,?,?,?,?,?,?,?,'accepted',?,?,?,?,?,?,?,'pending',?)",
      [session.org.id, session.user.id, active.id, active.version, signatoryName, signatoryEmail,
       signatoryRole || null, signatureImage, acceptedAt, String(active.content || ""), String(active.fee_config_json || "{}"),
       reference, AGREEMENT_ACCEPT_METHOD, evidence, invite.id, acceptedAt]);
    sig = await dbGet(env, "SELECT * FROM organizer_agreements WHERE id = ?", [(ins && ins.meta && ins.meta.last_row_id) || 0]);
  } catch(e){
    /* UNIQUE(organizer_id, agreement_id): a concurrent submit won the race. The
       acceptance is recorded either way - answer with the stored signature. */
    sig = await agreementSignatureFor(env, session.org.id, active.id);
    if(!sig) throw err(500, "We could not record your signature. Please try again.", "AGREEMENT_SIGN_FAILED");
  }

  /* The signed document: exact text + exact fee terms + signing record. Its own
     SHA-256 is computed over the record it prints, so the reference, terms and
     signing instant can be verified later against the stored hash. */
  const feeView = agreementFeeView(active);
  let recordSha = "";
  try {
    recordSha = await sha256Hex(JSON.stringify({
      reference: reference, agreement_id: active.id, version: active.version,
      content_hash: active.content_hash || null, fee: active.fee_config_json || "{}",
      accepted_at: acceptedAt, signatory_email: signatoryEmail, signature_image: signatureImage
    }));
  } catch(e){ recordSha = ""; }
  let stored = { key: null, sha256: recordSha, stored: false };
  try {
    const html = agreementDocumentHtml({
      signature: sig, agreement: active, organizer: session.org, user: session.user,
      brand: await emailBrandFor(env), fee_view: feeView,
      content: String(active.content || ""), sha256: recordSha
    });
    stored = await agreementStoreDocument(env, sig, html);
  } catch(e){
    console.error("AGREEMENT_DOC_BUILD_FAILED", String((e && e.message) || e));
  }
  await agreementAudit(env, request, {
    action: "agreement_signed", agreement_id: active.id, agreement_version: active.version,
    organizer_id: session.org.id, actor_user_id: session.user.id, actor_role: session.user.role,
    subject_user_id: session.user.id,
    detail: { reference: reference, invitation_id: invite.id, signatory_role: signatoryRole || null,
      document_sha256: stored.sha256 || null, document_stored: !!stored.stored }
  });
  if(stored.stored){
    await agreementAudit(env, request, {
      action: "document_generated", agreement_id: active.id, agreement_version: active.version,
      organizer_id: session.org.id, actor_user_id: session.user.id, actor_role: session.user.role,
      detail: { reference: reference, sha256: stored.sha256 }
    });
  }
  const delivery = await agreementSend(env, request, ctx.ctx, {
    to: signatoryEmail, to_name: session.user.full_name || "",
    template: "organizer_agreement_signed",
    dedupe_key: "agreement_signed:" + active.id + ":" + session.org.id,
    payload: {
      agreement: { id: active.id, title: active.title, version: active.version,
        effective_date: active.effective_date, summary: active.summary,
        reference: reference, signed_at: acceptedAt,
        signatory_name: signatoryName, signatory_email: signatoryEmail,
        fee_config: feeView.config },
      signatory_name: signatoryName,
      name: session.user.full_name || "", email: signatoryEmail
    }
  });
  try {
    await dbRun(env, "UPDATE organizer_agreements SET confirmation_email_status = ? WHERE id = ?",
      [(delivery && (delivery.queued ? "queued" : (delivery.duplicate ? "duplicate" : "failed"))) || "failed", sig.id]);
  } catch(e){ /* pre-0008 columns absent */ }
  const state = await agreementStateFor(env, session.org.id);
  return created({
    signature: agreementSignatureView(sig),
    state: agreementStatusPayload(state),
    document: { available: !!stored.stored, sha256: stored.sha256 || null },
    already_signed: false,
    message: "Your organizer agreement is signed. Publishing is now enabled for your events."
  }, cors);
}

/* GET /api/organizer/agreement/document[?reference=]
   The organizer's OWN signed document, as a downloadable HTML file. The object
   key is never exposed: the Worker reads R2 itself and streams the bytes, so a
   signed contract with personal data is not publicly readable. If the object is
   missing (storage was unavailable at signing) the document is rebuilt from the
   immutable snapshot on the signature row and re-stored. */
async function routeOrganizerAgreementDocument(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url, cors = corsFor(env, request);
  const session = await requireOrganizer(env, request);
  if(!session.org) throw err(403, "No organizer profile exists for this account.", "NO_ORGANIZER");
  const reference = vStr(url.searchParams.get("reference"), "reference", { max: 64 });
  const sig = reference
    ? await dbGet(env, "SELECT * FROM organizer_agreements WHERE reference = ? AND organizer_id = ?", [reference, session.org.id])
    : await dbGet(env, "SELECT * FROM organizer_agreements WHERE organizer_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", [session.org.id]);
  if(!sig) throw err(404, "No signed agreement document exists for this account yet.", "NOT_FOUND");
  let html = null;
  if(sig.document_key && env.BUCKET && typeof env.BUCKET.get === "function"){
    try {
      const obj = await env.BUCKET.get(sig.document_key);
      if(obj) html = await obj.text();
    } catch(e){ html = null; }
  }
  if(!html){
    const agreement = await agreementById(env, sig.agreement_id);
    const source = agreement || { version: sig.agreement_version, title: "Organizer Agreement",
      content: sig.content_snapshot, fee_config_json: sig.fee_snapshot_json, effective_date: null };
    html = agreementDocumentHtml({
      signature: sig, agreement: source, organizer: session.org, user: session.user,
      brand: await emailBrandFor(env), fee_view: agreementFeeView(source),
      content: String(sig.content_snapshot || ""), sha256: sig.document_sha256 || ""
    });
    try { await agreementStoreDocument(env, sig, html); } catch(e){ /* best effort */ }
  }
  await agreementAudit(env, request, {
    action: "document_downloaded", agreement_id: sig.agreement_id, agreement_version: sig.agreement_version,
    organizer_id: session.org.id, actor_user_id: session.user.id, actor_role: session.user.role,
    detail: { reference: sig.reference }
  });
  const headers = Object.assign({}, cors || {}, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"organizer-agreement-" + String(sig.reference || "document") + ".html\"",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store"
  });
  return new Response(html, { status: 200, headers: headers });
}


/* ============================================================ ADMIN ROUTES =====
   Registered twice - /api/admin/agreements* and /api/owner/agreements* - so the
   management surface is reachable from either naming convention. Every handler
   requires the owner role; there is no organizer-writable path into these rows. */
const AGREEMENT_FANOUT_LIMIT = 500;
async function agreementVersionRow(env, a){
  const signatures = await dbGet(env,
    "SELECT COUNT(*) AS n FROM organizer_agreements WHERE agreement_id = ? AND status = 'accepted'", [a.id]);
  return Object.assign(agreementVersionView(a), {
    /* Owner-only route: the draft text travels with the row so the editor can be
       opened without a second fetch. It is never exposed to organizers. */
    content: String(a.content || ""),
    content_format: agreementContentFormat(a.content),
    content_length: String(a.content || "").length,
    fee: agreementFeeView(a),
    signatures: Number((signatures && signatures.n) || 0),
    editable: String(a.status) === "draft"
  });
}
/* GET  /agreements        - every version + signature counts + coverage stats
   POST /agreements        - create a DRAFT version (immutable once activated) */
async function routeAdminAgreements(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const actor = await requireOwner(env, request);
  if(request.method === "POST"){
    const body = await readJson(request);
    const version = vStr(body.version, "version", { max: AGREEMENT_MAX_VERSION, required: true, label: "Version" });
    const title = vStr(body.title, "title", { max: AGREEMENT_MAX_TITLE, required: true, label: "Title" });
    const content = agreementNormaliseContent(body.content, true);
    const summary = vStr(body.summary, "summary", { max: AGREEMENT_MAX_SUMMARY });
    const effectiveDate = body.effective_date ? vDate(body.effective_date, "effective date", true) : null;
    const fee = agreementFeeConfig(body.fee_config);
    const hash = await sha256Hex(version + "|" + title + "|" + content + "|" + fee.json);
    let id = null;
    try {
      const ins = await dbRun(env,
        "INSERT INTO platform_agreements (version, title, content, summary, fee_config_json, status, effective_date, content_hash, created_by, created_at, updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)",
        [version, title, content, summary || null, fee.json, effectiveDate, hash, actor.user.id, touch(), touch()]);
      id = (ins && ins.meta && ins.meta.last_row_id) || null;
    } catch(e){
      const clash = await dbGet(env, "SELECT id FROM platform_agreements WHERE version = ?", [version]);
      if(clash) throw err(409, "An agreement with version \"" + version + "\" already exists.", "AGREEMENT_VERSION_EXISTS");
      throw err(500, "The agreement version could not be saved. Please try again.", "AGREEMENT_SAVE_FAILED");
    }
    const row = await agreementById(env, id);
    await agreementAudit(env, request, {
      action: "agreement_created", agreement_id: id, agreement_version: version,
      actor_user_id: actor.user.id, actor_role: "owner",
      detail: { title: title, effective_date: effectiveDate, content_hash: hash }
    });
    return created({ agreement: await agreementVersionRow(env, row),
      message: "Draft version " + version + " created. Review it, then activate it to make it the required agreement." }, cors);
  }
  const rows = await dbAll(env, "SELECT * FROM platform_agreements ORDER BY id DESC LIMIT 200", []);
  const list = [];
  for(const row of rows) list.push(await agreementVersionRow(env, row));
  const active = await activeAgreement(env);
  const totals = await dbGet(env,
    "SELECT (SELECT COUNT(*) FROM organizers WHERE status = 'active') AS organizers, " +
    "(SELECT COUNT(*) FROM organizer_agreements WHERE status = 'accepted') AS signatures", []);
  let unsigned = 0;
  if(active){
    const un = await dbGet(env,
      "SELECT COUNT(*) AS n FROM organizers og WHERE og.status = 'active' AND NOT EXISTS " +
      "(SELECT 1 FROM organizer_agreements oa WHERE oa.organizer_id = og.id AND oa.agreement_id = ? AND oa.status = 'accepted')",
      [active.id]);
    unsigned = Number((un && un.n) || 0);
  }
  return ok({
    agreements: list,
    active: active ? agreementVersionView(active) : null,
    stats: { total_organizers: Number((totals && totals.organizers) || 0),
      total_signatures: Number((totals && totals.signatures) || 0),
      unsigned_for_active: unsigned }
  }, cors);
}


/* PATCH /agreements/:id - a DRAFT version only. Activated versions are
   immutable: any commercial change must be a NEW version, so the terms an
   organizer accepted can never move underneath their signature. */
async function routeAdminAgreementUpdate(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const actor = await requireOwner(env, request);
  const id = vInt(ctx.params.id, "agreement", { min: 1, label: "Agreement id" });
  const existing = await agreementById(env, id);
  if(!existing) throw err(404, "That agreement version does not exist.", "NOT_FOUND");
  if(String(existing.status) !== "draft"){
    throw err(409, "Version " + existing.version + " has been activated and can no longer be edited. Create a new version instead.", "AGREEMENT_IMMUTABLE");
  }
  const body = await readJson(request);
  const current = { version: existing.version, title: existing.title, content: existing.content,
    summary: existing.summary || null, effective_date: existing.effective_date || null,
    fee_json: existing.fee_config_json || "{}" };
  if(body.version !== undefined) current.version = vStr(body.version, "version", { max: AGREEMENT_MAX_VERSION, required: true, label: "Version" });
  if(body.title !== undefined) current.title = vStr(body.title, "title", { max: AGREEMENT_MAX_TITLE, required: true, label: "Title" });
  if(body.content !== undefined) current.content = agreementNormaliseContent(body.content, true);
  if(body.summary !== undefined) current.summary = vStr(body.summary, "summary", { max: AGREEMENT_MAX_SUMMARY }) || null;
  if(body.effective_date !== undefined) current.effective_date = body.effective_date ? vDate(body.effective_date, "effective date", true) : null;
  if(body.fee_config !== undefined) current.fee_json = agreementFeeConfig(body.fee_config).json;
  if(body.version !== undefined){
    const clash = await dbGet(env, "SELECT id FROM platform_agreements WHERE version = ? AND id <> ?", [current.version, id]);
    if(clash) throw err(409, "An agreement with version \"" + current.version + "\" already exists.", "AGREEMENT_VERSION_EXISTS");
  }
  const hash = await sha256Hex(current.version + "|" + current.title + "|" + current.content + "|" + current.fee_json);
  await dbRun(env,
    "UPDATE platform_agreements SET version = ?, title = ?, content = ?, summary = ?, fee_config_json = ?, effective_date = ?, content_hash = ?, updated_at = ? WHERE id = ?",
    [current.version, current.title, current.content, current.summary, current.fee_json, current.effective_date, hash, touch(), id]);
  await agreementAudit(env, request, {
    action: "agreement_updated", agreement_id: id, agreement_version: current.version,
    actor_user_id: actor.user.id, actor_role: "owner",
    detail: { fields: Object.keys(body), content_hash: hash }
  });
  const row = await agreementById(env, id);
  return ok({ agreement: await agreementVersionRow(env, row), message: "Draft updated." }, cors);
}


/* The bounded notification fan-out shared by activation and reminders. Each
   organizer is handled independently: one bad address or missing profile never
   stops the loop, and nothing here can publish or sign on anyone's behalf. */
async function agreementFanout(env, request, task, agreement, mode, actor){
  const sql = "SELECT og.id AS organizer_id, og.user_id, u.full_name, u.email, " +
    "(SELECT COUNT(*) FROM organizer_agreements oa WHERE oa.organizer_id = og.id AND oa.status = 'accepted') AS signed_before " +
    "FROM organizers og JOIN users u ON u.id = og.user_id " +
    "WHERE og.status = 'active' AND u.status = 'active' AND u.email IS NOT NULL AND u.email <> '' " +
    (mode === "reminder" ? "AND NOT EXISTS (SELECT 1 FROM organizer_agreements oa WHERE oa.organizer_id = og.id AND oa.agreement_id = ? AND oa.status = 'accepted') " : "") +
    "ORDER BY og.id LIMIT " + AGREEMENT_FANOUT_LIMIT;
  const rows = await dbAll(env, sql, mode === "reminder" ? [agreement.id] : []);
  const out = { targeted: rows.length, invited: 0, updated: 0, reminded: 0, skipped: 0 };
  const page = agreementPageUrl(env, request);
  for(const r of rows){
    try {
      const to = emailRecipient(r.email);
      if(!to){ out.skipped++; continue; }
      if(mode === "activate" && Number(r.signed_before) > 0){
        /* They accepted a previous version: this is a re-acceptance notice. */
        const sent = await agreementSend(env, request, task, {
          to: to, to_name: r.full_name || "", template: "organizer_agreement_updated",
          dedupe_key: "agreement_updated:" + agreement.id + ":" + r.user_id,
          payload: { agreement: { id: agreement.id, title: agreement.title, version: agreement.version,
            effective_date: agreement.effective_date, summary: agreement.summary,
            fee_config: agreementFeeView(agreement).config },
            review_url: page, name: r.full_name || "", email: to }
        });
        if(sent && sent.queued) out.updated++; else out.skipped++;
        continue;
      }
      /* Never signed (activation) or still unsigned (reminder): a fresh
         single-use link, so the email itself is enough to complete signing. */
      const issued = await agreementIssueInvite(env, request, {
        agreement: agreement,
        user: { id: r.user_id, email: r.email, organizer_id: r.organizer_id },
        actor_user_id: actor ? actor.user.id : null, actor_role: "owner"
      });
      const template = mode === "reminder" ? "organizer_agreement_reminder" : "organizer_agreement_invitation";
      const day = agreementSqlStamp(Date.now()).slice(0, 10).replace(/-/g, "");
      const sent = await agreementSend(env, request, task, {
        to: to, to_name: r.full_name || "", template: template,
        dedupe_key: mode === "reminder"
          ? "agreement_reminder:" + agreement.id + ":" + r.user_id + ":" + day
          : "agreement_invitation:" + agreement.id + ":" + r.user_id + ":" + issued.invitation.id,
        payload: { agreement: { id: agreement.id, title: agreement.title, version: agreement.version,
          effective_date: agreement.effective_date, summary: agreement.summary,
          expires_at: issued.invitation.expires_at, fee_config: agreementFeeView(agreement).config },
          review_url: issued.review_url, name: r.full_name || "", email: to }
      });
      if(sent && sent.queued){ if(mode === "reminder") out.reminded++; else out.invited++; }
      else out.skipped++;
    } catch(e){
      out.skipped++;
      console.error("AGREEMENT_FANOUT_ERROR", mode, String((e && e.message) || e));
    }
  }
  return out;
}


/* POST /agreements/:id/activate
   Makes this version THE agreement. The previous active version is superseded
   first (the partial unique index allows only one active row), existing
   signatures keep their own snapshots, and every organizer is told what they
   must do next. Publication stays blocked until each organizer accepts. */
async function routeAdminAgreementActivate(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const actor = await requireOwner(env, request);
  const id = vInt(ctx.params.id, "agreement", { min: 1, label: "Agreement id" });
  const target = await agreementById(env, id);
  if(!target) throw err(404, "That agreement version does not exist.", "NOT_FOUND");
  if(String(target.status) === "active") throw err(409, "Version " + target.version + " is already the active agreement.", "AGREEMENT_ALREADY_ACTIVE");
  if(String(target.status) === "archived") throw err(409, "An archived version cannot be re-activated. Create a new version instead.", "AGREEMENT_IMMUTABLE");
  const previous = await activeAgreement(env);
  if(previous && Number(previous.id) !== Number(id)){
    await dbRun(env, "UPDATE platform_agreements SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active'", [touch(), previous.id]);
  }
  const res = await dbRun(env,
    "UPDATE platform_agreements SET status = 'active', activated_at = ?, activated_by = ?, updated_at = ? WHERE id = ? AND status <> 'active'",
    [touch(), actor.user.id, touch(), id]);
  const changed = Number((res && res.meta && res.meta.changes) || 0);
  if(changed !== 1){
    /* A concurrent activation won the race; leave the winner's row alone. */
    throw err(409, "Another version was activated at the same moment. Reload and check which version is now active.", "AGREEMENT_CONFLICT");
  }
  await agreementAudit(env, request, {
    action: "agreement_activated", agreement_id: id, agreement_version: target.version,
    actor_user_id: actor.user.id, actor_role: "owner",
    detail: { superseded: previous ? previous.version : null, fee_config: target.fee_config_json || "{}" }
  });
  let fanout = { targeted: 0, invited: 0, updated: 0, reminded: 0, skipped: 0 };
  try {
    fanout = await agreementFanout(env, request, ctx.ctx, target, "activate", actor);
  } catch(e){
    console.error("AGREEMENT_ACTIVATE_FANOUT_ERROR", String((e && e.message) || e));
  }
  const row = await agreementById(env, id);
  return ok({
    agreement: await agreementVersionRow(env, row),
    superseded: previous ? agreementVersionView(previous) : null,
    notifications: fanout,
    message: "Version " + target.version + " is now the required organizer agreement. Organizers must accept it before their next publication."
  }, cors);
}


/* POST /agreements/:id/invite  {organizer_id}
   Sends one organizer their personal single-use signing link. The raw token is
   deliberately NOT returned: it travels only by email to the invited address. */
async function routeAdminAgreementInvite(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const actor = await requireOwner(env, request);
  const id = vInt(ctx.params.id, "agreement", { min: 1, label: "Agreement id" });
  const body = await readJson(request);
  const organizerId = vInt(body.organizer_id, "organizer", { min: 1, label: "Organizer id" });
  const agreement = await agreementById(env, id);
  if(!agreement) throw err(404, "That agreement version does not exist.", "NOT_FOUND");
  if(String(agreement.status) !== "active") throw err(409, "Invitations can only be sent for the active agreement version.", "AGREEMENT_NOT_ACTIVE");
  const org = await dbGet(env, "SELECT og.*, u.full_name, u.email, u.status AS user_status FROM organizers og JOIN users u ON u.id = og.user_id WHERE og.id = ?", [organizerId]);
  if(!org) throw err(404, "That organizer does not exist.", "NOT_FOUND");
  if(String(org.status) !== "active" || String(org.user_status) !== "active"){
    throw err(409, "That organizer account is not active.", "ORGANIZER_INACTIVE");
  }
  const signed = await agreementSignatureFor(env, organizerId, agreement.id);
  if(signed) throw err(409, "That organizer has already accepted version " + agreement.version + ".", "ALREADY_SIGNED");
  const issued = await agreementIssueInvite(env, request, {
    agreement: agreement, user: { id: org.user_id, email: org.email, organizer_id: organizerId },
    actor_user_id: actor.user.id, actor_role: "owner"
  });
  const sent = await agreementSend(env, request, ctx.ctx, {
    to: issued.invitation.email, to_name: org.full_name || "",
    template: "organizer_agreement_invitation",
    dedupe_key: "agreement_invitation:" + agreement.id + ":" + org.user_id + ":" + issued.invitation.id,
    payload: { agreement: { id: agreement.id, title: agreement.title, version: agreement.version,
      effective_date: agreement.effective_date, summary: agreement.summary,
      expires_at: issued.invitation.expires_at, fee_config: agreementFeeView(agreement).config },
      review_url: issued.review_url, name: org.full_name || "", email: issued.invitation.email }
  });
  return ok({
    organizer_id: organizerId, email: issued.invitation.email,
    expires_at: issued.invitation.expires_at, queued: !!(sent && sent.queued),
    message: "A single-use signing link was emailed to " + issued.invitation.email + "."
  }, cors);
}
/* POST /agreements/:id/remind - one reminder per organizer per day, for the
   organizers who still have not accepted this version. */
async function routeAdminAgreementRemind(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  const actor = await requireOwner(env, request);
  const id = vInt(ctx.params.id, "agreement", { min: 1, label: "Agreement id" });
  const agreement = await agreementById(env, id);
  if(!agreement) throw err(404, "That agreement version does not exist.", "NOT_FOUND");
  if(String(agreement.status) !== "active") throw err(409, "Reminders are only sent for the active agreement version.", "AGREEMENT_NOT_ACTIVE");
  const fanout = await agreementFanout(env, request, ctx.ctx, agreement, "reminder", actor);
  await agreementAudit(env, request, {
    action: "reminder_sent", agreement_id: agreement.id, agreement_version: agreement.version,
    actor_user_id: actor.user.id, actor_role: "owner",
    detail: { targeted: fanout.targeted, reminded: fanout.reminded, skipped: fanout.skipped }
  });
  return ok({ notifications: fanout,
    message: fanout.reminded + " reminder" + (fanout.reminded === 1 ? "" : "s") + " queued for unsigned organizers." }, cors);
}


/* GET /agreements/:id/signatures - who accepted this version, when, and under
   which reference. Read-only: organizers cannot be revoked from here; a
   signature is only ever REVOKED through its own dedicated action + audit. */
async function routeAdminAgreementSignatures(ctx){
  const env = ctx.env, request = ctx.request, cors = corsFor(env, request);
  await requireOwner(env, request);
  const id = vInt(ctx.params.id, "agreement", { min: 1, label: "Agreement id" });
  const agreement = await agreementById(env, id);
  if(!agreement) throw err(404, "That agreement version does not exist.", "NOT_FOUND");
  const rows = await dbAll(env,
    "SELECT oa.*, og.business_name, u.full_name AS signed_by_name FROM organizer_agreements oa " +
    "LEFT JOIN organizers og ON og.id = oa.organizer_id LEFT JOIN users u ON u.id = oa.user_id " +
    "WHERE oa.agreement_id = ? ORDER BY oa.id DESC LIMIT 200", [id]);
  return ok({
    agreement: agreementVersionView(agreement),
    signatures: rows.map(r => Object.assign(agreementSignatureView(r), {
      organizer_id: r.organizer_id, business_name: r.business_name || null, signed_by_name: r.signed_by_name || null
    })),
    total: rows.length
  }, cors);
}
/* GET /agreements/audit?limit=&action=&organizer_id=
   The append-only trail. Placed before the parameterised routes in ROUTES so
   "audit" is never swallowed as an :id. */
async function routeAdminAgreementAudit(ctx){
  const env = ctx.env, request = ctx.request, url = ctx.url, cors = corsFor(env, request);
  await requireOwner(env, request);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const action = vStr(url.searchParams.get("action"), "action", { max: 60 });
  const organizerId = url.searchParams.get("organizer_id");
  const where = [], params = [];
  if(action){ where.push("action = ?"); params.push(action); }
  if(organizerId){ where.push("organizer_id = ?"); params.push(vInt(organizerId, "organizer", { min: 1 })); }
  const clause = where.length ? (" WHERE " + where.join(" AND ")) : "";
  const rows = await dbAll(env, "SELECT * FROM agreement_audit_log" + clause + " ORDER BY id DESC LIMIT " + limit, params);
  const total = await dbGet(env, "SELECT COUNT(*) AS n FROM agreement_audit_log" + clause, params);
  return ok({
    entries: rows.map(r => ({
      id: r.id, action: r.action, agreement_id: r.agreement_id, agreement_version: r.agreement_version,
      organizer_id: r.organizer_id, actor_user_id: r.actor_user_id, actor_role: r.actor_role,
      subject_user_id: r.subject_user_id,
      detail: (function(){ try { return r.detail_json ? JSON.parse(r.detail_json) : null; } catch(e){ return null; } })(),
      created_at: r.created_at
    })),
    total: Number((total && total.n) || 0),
    meta: { limit: limit }
  }, cors);
}


/* ============================================================================
   ROUTER
   ========================================================================== */
const ROUTES = [
  ["GET",    "/api/health",                                routeHealth],
  ["GET",    "/api/categories",                            routeCategories],
  ["GET",    "/api/events",                                routePublicEvents],
  ["GET",    "/api/events/:slug",                          routePublicEvent],
  ["GET",    "/api/events/:id/tickets",                    routePublicEventTickets],
  ["POST",   "/api/orders",                                routeCreateOrder],
  ["POST",   "/api/contact",                               routeContact],
  ["POST",   "/api/auth/turnstile",                         routeAuthTurnstile],
  ["POST",   "/api/auth/register",                         routeRegister],
  ["GET",    "/api/me",                                    routeMe],
  ["POST",   "/api/check-in",                              routeCheckIn],
  ["POST",   "/api/payments/:provider/initiate",           routeInitiatePayment],
  ["POST",   "/api/payments/create",                      routePaymentCreate],
  ["GET",    "/api/payments/:reference",                   routePaymentStatus],
  ["GET",    "/api/payments/:id/status",                   routePaymentStatusById],
  ["POST",   "/api/webhooks/paystack",                     routePaystackWebhook],
  ["POST",   "/api/webhooks/pesapal",                      routePesapalWebhook],
  ["GET",    "/api/webhooks/pesapal",                      routePesapalWebhook],
  ["POST",   "/api/webhooks/payhero",                      routePayheroWebhook],
  ["GET",    "/api/orders/:reference/tickets",             routeOrderTickets],
  ["POST",   "/api/orders/lookup",                         routeOrderLookup],
  ["GET",    "/api/tickets/:ticketNumber/qr.png",          routeTicketQr],
  ["GET",    "/api/tickets/:ticketNumber",                 routeTicketByNumber],
  ["POST",   "/api/tickets/send-email",                   routeSendTicketEmail],
  /* free ticket verification (Email OTP + IP abuse prevention) */
  ["POST",   "/api/tickets/free/verify/request",           routeFreeVerifyRequest],
  ["POST",   "/api/tickets/free/verify/confirm",           routeFreeVerifyConfirm],
  ["POST",   "/api/tickets/free/register",                 routeFreeRegister],
  /* organizer */
  ["GET",    "/api/organizer/dashboard",                   routeOrganizerDashboard],
  ["GET",    "/api/organizer/events",                      routeOrganizerEvents],
  ["POST",   "/api/organizer/events",                      routeOrganizerEvents],
  ["GET",    "/api/organizer/events/:id",                  routeOrganizerEvent],
  ["PUT",    "/api/organizer/events/:id",                  routeOrganizerEvent],
  ["DELETE", "/api/organizer/events/:id",                  routeOrganizerEvent],
  ["POST",   "/api/organizer/events/:id/poster",           routeOrganizerPoster],
  ["DELETE", "/api/organizer/events/:id/poster",           routeOrganizerPoster],
  ["GET",    "/api/organizer/events/:id/tickets",          routeOrganizerTickets],
  ["POST",   "/api/organizer/events/:id/tickets",          routeOrganizerTickets],
  ["PUT",    "/api/organizer/events/:id/tickets/:tid",     routeOrganizerTicketWrite],
  ["DELETE", "/api/organizer/events/:id/tickets/:tid",     routeOrganizerTicketWrite],
  ["PUT",    "/api/organizer/tickets/:id",                 routeOrganizerTicketWrite],
  ["DELETE", "/api/organizer/tickets/:id",                 routeOrganizerTicketWrite],
  ["GET",    "/api/organizer/events/:id/orders",           routeOrganizerEventOrders],
  ["GET",    "/api/organizer/events/:id/attendees",        routeOrganizerEventAttendees],
  ["GET",    "/api/organizer/orders",                      routeOrganizerOrders],
  ["GET",    "/api/organizer/orders/:id",                  routeOrganizerOrder],
  ["GET",    "/api/organizer/attendees.csv",               routeOrganizerAttendeesCsv],
  ["GET",    "/api/organizer/attendees",                   routeOrganizerAttendees],
  ["PUT",    "/api/organizer/profile",                     routeOrganizerProfile],
  ["POST",   "/api/organizer/logo",                        routeOrganizerLogo],
  ["GET",    "/api/organizer/payment-settings",            routePaymentProvidersGet],
  ["PUT",    "/api/organizer/payment-settings",            routePaymentSettingsPut],
  ["POST",   "/api/organizer/payment-settings/test",       routePaymentSettingsTest],
  /* unified three-provider payment configuration */
  ["GET",    "/api/organizer/payment-providers",            routePaymentProvidersGet],
  ["POST",   "/api/organizer/payment-providers/:provider",  routeProviderPut],
  ["DELETE", "/api/organizer/payment-providers/:provider",  routeProviderDelete],
  ["POST",   "/api/organizer/payment-providers/:provider/test", routeProviderTest],
  ["POST",   "/api/organizer/payment-provider/select",      routeProviderSelect],
  ["GET",    "/api/organizer/payment-provider/status",      routePaymentProviderStatus],
  /* organizer agreement (mandatory before publication) */
  ["GET",    "/api/organizer/agreement",                    routeOrganizerAgreement],
  ["GET",    "/api/organizer/agreement/status",             routeOrganizerAgreement],
  ["POST",   "/api/organizer/agreement/invite",             routeOrganizerAgreementInvite],
  ["GET",    "/api/organizer/agreement/verify",             routeOrganizerAgreementVerify],
  ["POST",   "/api/organizer/agreement/sign",               routeOrganizerAgreementSign],
  ["GET",    "/api/organizer/agreement/document",           routeOrganizerAgreementDocument],
  /* platform owner */
  ["GET",    "/api/owner/dashboard",                       routeOwnerDashboard],
  ["GET",    "/api/owner/organizers",                      routeOwnerOrganizers],
  ["GET",    "/api/owner/organizers/:id/agreement/document", routeOwnerOrganizerAgreementDocument],
  ["PUT",    "/api/owner/organizers/:id",                  routeOwnerOrganizers],
  ["GET",    "/api/owner/events",                          routeOwnerEvents],
  ["PUT",    "/api/owner/events/:id",                      routeOwnerEvents],
  ["GET",    "/api/owner/orders",                          routeOwnerOrders],
  ["POST",   "/api/owner/orders/:id/reconcile",              routeOwnerReconcile],
  ["GET",    "/api/owner/events/:id/settlement",           routeOwnerEventSettlement],
  ["GET",    "/api/owner/users",                           routeOwnerUsers],
  ["GET",    "/api/owner/settings",                        routeOwnerSettings],
  ["PUT",    "/api/owner/settings",                        routeOwnerSettings],
  /* owner payment settings (owner payment mode) */
  ["GET",    "/api/owner/payment-providers",               routeOwnerPaymentProvidersGet],
  ["POST",   "/api/owner/payment-providers/:provider",     routeOwnerProviderPut],
  ["DELETE", "/api/owner/payment-providers/:provider",     routeOwnerProviderDelete],
  ["POST",   "/api/owner/payment-providers/:provider/test", routeOwnerProviderTest],
  ["POST",   "/api/owner/payment-provider/select",         routeOwnerProviderSelect],
  ["GET",    "/api/owner/payment-provider/status",         routeOwnerPaymentProvidersGet],
  /* owner email admin (Brevo outbox) */
  ["GET",    "/api/owner/emails",                          routeOwnerEmails],
  ["GET",    "/api/owner/emails/templates",                routeOwnerEmailTemplates],
  ["POST",   "/api/owner/emails/dispatch",                 routeOwnerEmailDispatch],
  ["POST",   "/api/owner/emails/send",                     routeOwnerEmailSend],
  ["POST",   "/api/owner/emails/test",                     routeOwnerEmailTest],
  ["POST",   "/api/owner/emails/:id/resend",               routeOwnerEmailResend],
  /* agreement administration - registered under /api/admin and /api/owner so
     both naming conventions reach the same owner-only handlers */
  ["GET",    "/api/admin/agreements/audit",                 routeAdminAgreementAudit],
  ["GET",    "/api/admin/agreements",                       routeAdminAgreements],
  ["POST",   "/api/admin/agreements",                       routeAdminAgreements],
  ["PATCH",  "/api/admin/agreements/:id",                   routeAdminAgreementUpdate],
  ["POST",   "/api/admin/agreements/:id/activate",          routeAdminAgreementActivate],
  ["POST",   "/api/admin/agreements/:id/invite",            routeAdminAgreementInvite],
  ["POST",   "/api/admin/agreements/:id/remind",            routeAdminAgreementRemind],
  ["GET",    "/api/admin/agreements/:id/signatures",        routeAdminAgreementSignatures],
  ["GET",    "/api/owner/agreements/audit",                 routeAdminAgreementAudit],
  ["GET",    "/api/owner/agreements",                       routeAdminAgreements],
  ["POST",   "/api/owner/agreements",                       routeAdminAgreements],
  ["PATCH",  "/api/owner/agreements/:id",                   routeAdminAgreementUpdate],
  ["POST",   "/api/owner/agreements/:id/activate",          routeAdminAgreementActivate],
  ["POST",   "/api/owner/agreements/:id/invite",            routeAdminAgreementInvite],
  ["POST",   "/api/owner/agreements/:id/remind",            routeAdminAgreementRemind],
  ["GET",    "/api/owner/agreements/:id/signatures",        routeAdminAgreementSignatures]
];
function splitPath(value){
  const out = [];
  for(const raw of String(value).split("/")){
    if(!raw) continue;
    try { out.push(decodeURIComponent(raw)); } catch(e){ out.push(raw); }
  }
  return out;
}
/* ============================================================================
   LEGACY PAGE LINKS ON THE WORKER ORIGIN
   ----------------------------------------------------------------------------
   Emails sent before FRONTEND_URL was configured carried page links built
   from the Worker's own origin (the old appBase()/callbackUrlFor() fallback),
   and pre-cleanup links may still use the .html file names. Both shapes are
   bounced to the production site - 302 for query-bearing payment links (the
   reference must survive), 301 for plain page links.
   ========================================================================== */
const LEGACY_PAGE_RE = /^(?:\/(?:about|attendees|check-in|checkout|contact|create-event|edit-event|events|forgot-password|login|orders|organizer-dashboard|organizer-events|organizer-settings|organizer|owner-dashboard|owner-events|owner-login|owner-orders|owner-organizers|owner-settings|payment-failed|payment-success|privacy|register|sell-your-tickets|terms|ticket-types|ticket|event)(?:\.html)?|\/index\.html)$/;
function legacyPageTarget(pathname){
  if(pathname === "/index.html") return "/";
  /* The separate /owner-login/ page was retired: owners sign in at /login/
     like everyone else and the Worker routes them by role. Keeping the name
     in LEGACY_PAGE_RE above means old bookmarks and emails are still caught
     and folded onto the one sign-in page instead of a dead folder. */
  if(pathname === "/owner-login" || pathname === "/owner-login.html") return "/login/";
  if(!/\.html$/.test(pathname)) return pathname.replace(/\/+$/, "") + "/";
  return pathname.replace(/\.html$/, "") + "/";
}
function legacyPageRedirect(env, request, url, pathname){
  if(request.method !== "GET" && request.method !== "HEAD") return null;
  if(!LEGACY_PAGE_RE.test(pathname)) return null;
  const target = PRODUCTION_FRONTEND_URL + legacyPageTarget(pathname) + url.search;
  /* A payment callback carries ?reference= and must never be cached as
     permanent; plain page links are safe to remember forever. */
  return Response.redirect(target, url.search ? 302 : 301);
}
function matchRoute(method, pathname){
  const segs = splitPath(pathname);
  let pathExists = false;
  for(const route of ROUTES){
    const parts = splitPath(route[1]);
    if(parts.length !== segs.length) continue;
    const params = {};
    let matched = true;
    for(let i = 0; i < parts.length; i++){
      if(parts[i].charAt(0) === ":"){
        if(!segs[i]){ matched = false; break; }
        params[parts[i].slice(1)] = segs[i];
      } else if(parts[i] !== segs[i]){ matched = false; break; }
    }
    if(!matched) continue;
    pathExists = true;
    if(route[0] === method) return { handler: route[2], params: params };
  }
  return pathExists ? { method_not_allowed: true } : null;
}

/* ============================================================================
   WORKER ENTRY POINT
   ========================================================================== */
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if(request.method === "OPTIONS") return preflight(env, request);

      /* Media object keys contain slashes, so they are handled before the table. */
      if(pathname.indexOf("/media/") === 0){
        if(request.method !== "GET" && request.method !== "HEAD"){
          throw err(405, "That method is not allowed here.", "METHOD");
        }
        return withCors(env, request, await routeMedia({
          env: env, request: request, url: url,
          params: { key: pathname.slice("/media/".length) }
        }));
      }

      const match = matchRoute(request.method, pathname);
      if(!match){
        if(pathname.indexOf("/api/") === 0) throw err(404, "That endpoint does not exist.", "NOT_FOUND");
        const bounce = legacyPageRedirect(env, request, url, pathname);
        if(bounce) return bounce;
        return withCors(env, request, new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
      }
      if(match.method_not_allowed) throw err(405, "That method is not allowed here.", "METHOD");

      const res = await match.handler({
        env: env, request: request, url: url, params: match.params, ctx: ctx
      });
      if(res instanceof Response) return withCors(env, request, res);
      return withCors(env, request, ok(res || {}));
    } catch(e){
      return errorResponse(e, env, request);
    }
  },
  /* Cron Trigger (optional but recommended): retries anything still queued, so
     a short Brevo outage heals itself without a human clicking "Flush queue".
     Add it in the dashboard (Worker -> Settings -> Triggers -> Cron) or in
     wrangler.toml, for example every five minutes. Every path that queues mail
     also flushes inline, so this is a safety net rather than a dependency. */
  // wrangler.toml:  [triggers]  crons = ["*/5 * * * *"]
  async scheduled(event, env, ctx){
    /* Expired rate-limit windows are removed here too, so the table stays small
       even on a quiet day (and even if the random in-request sweep never fires). */
    const jobs = [dispatchOutbox(env, EMAIL_DISPATCH_LIMIT), rateSweep(env, true), freeTicketSweep(env, true)];
    if(ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(Promise.all(jobs));
    return Promise.all(jobs);
  }
};