/* ============================================================================
   Prince Alex TicketHub - transactional email engine (Brevo)
   Powered by Prince Alex Digital
   ----------------------------------------------------------------------------
   ONE file, ZERO dependencies. It owns four things:

     1. TEMPLATES      every email the platform can send, as a pure
                       (payload) -> { subject, html, text } renderer.
     2. THE DESIGN     a table based, inline-CSS layout (600px, responsive)
                       that survives Gmail, Outlook and Apple Mail.
     3. THE TRANSPORT  POST https://api.brevo.com/v3/smtp/email with the
                       BREVO_API_KEY Worker secret. The key never leaves the
                       Worker and is never read from the browser or D1.
     4. THE OUTBOX     email_outbox (D1) is the queue. queueEmail() never
                       throws into a payment path, dispatchOutbox() delivers
                       and records the result. With no BREVO_API_KEY every
                       message stays queued instead of being lost.

   Payload contract used by the templates (all fields optional, the renderers
   degrade gracefully):

     {
       brand:     { product, parent, tagline, support_email, support_phone, website },
       links:     { home, events, ticket, order, event, organizer, support, terms, privacy },
       customer:  { name, email, phone },
       order:     { number, status, amount, currency, paid_at, created_at, note },
       event:     { title, slug, date, time, end_time, venue, location, poster_url, url,
                    organizer_name, organizer_email, organizer_phone, organizer_logo },
       items:     [ { name, quantity, unit_price, subtotal } ],
       tickets:   [ { number, type, attendee, status, qr_url, qr_base64, ticket_url } ],
       message:   { name, email, subject, body, sent_at },
       reason:    free text shown inside an alert box (cancellation, failure...),
       meta:      free shape for internal notes
     }
/* ---------------------------------------------------------------- brand ---- */
export const BRAND = {
  product: "Prince Alex TicketHub",
  parent: "Powered by Prince Alex Digital",
  tagline: "Kenyan event ticketing, end to end",
  support_email: "support@princealex.digital",
  support_phone: "",
  website: "https://tickethub.princealex.digital"
};
/* Softer palette for a cleaner transactional look. We keep the platform
   recognisable without using a heavy branded header or saturated accents. */
export const COLORS = {
  ink: "#1F2937", body: "#475467", muted: "#667085", faint: "#8A94A6",
  line: "#E7EDF5", bg: "#F5F7FB", card: "#FFFFFF", soft: "#F8FBFF",
  primary: "#4C6FFF", primary_dark: "#3457D5", accent: "#DDEBFF",
  ok_bg: "#F0FDF4", ok_ink: "#166534", warn_bg: "#FFF7ED", warn_ink: "#B45309",
  err_bg: "#FFF1F2", err_ink: "#B91C1C", info_bg: "#EEF5FF", info_ink: "#1D4ED8"
};
export const EMAIL_FONT = "'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif";
export const EMAIL_MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

/* -------------------------------------------------------------- helpers ---- */
export function esc(value){
  return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
const pad2 = n => String(n).padStart(2, "0");
export function money(amount, currency){
  const n = Number(amount || 0);
  const cur = String(currency || "KES").toUpperCase();
  const label = cur === "KES" ? "KSh" : cur;
  const value = Number.isFinite(n)
    ? n.toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "0";
  return label + " " + value;
}
function asDate(value){
  const raw = String(value == null ? "" : value).trim();
  if(!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if(!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(d.getTime()) ? null : d;
}
export function fmtDate(value){
  const d = asDate(value);
  if(!d) return String(value == null ? "" : value);
  return d.toLocaleDateString("en-KE", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
export function fmtShortDate(value){
  const d = asDate(value);
  if(!d) return String(value == null ? "" : value);
  return d.toLocaleDateString("en-KE", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}
export function fmtTime(value){
  const raw = String(value == null ? "" : value).trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(raw);
  if(!m) return raw;
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + pad2(m[2]) + " " + suffix;
}
/* Accepts "YYYY-MM-DD HH:MM:SS" (D1 datetime) or a full ISO string. Kenya is
   UTC+3 all year round, and the value passed here is a UTC timestamp (touch() /
   datetime('now')), so it is shifted to Nairobi time before it is printed: no
   email ever shows a time three hours behind the clock on the wall. */
const KE_OFFSET_MS_EMAIL = 3 * 60 * 60 * 1000;
export function fmtDateTime(value){
  const raw = String(value == null ? "" : value).trim();
  if(!raw) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if(!m) return fmtShortDate(raw);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  const eat = new Date(utc + KE_OFFSET_MS_EMAIL);
  return eat.toLocaleDateString("en-KE", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })
    + ", " + fmtTime(pad2(eat.getUTCHours()) + ":" + pad2(eat.getUTCMinutes()));
}
export function firstName(name){
  const first = String(name == null ? "" : name).trim().split(/\s+/)[0];
  return first || "there";
}
export function totalQuantity(items){
  return (Array.isArray(items) ? items : []).reduce((sum, it) => sum + Number((it && it.quantity) || 0), 0);
}
export function ticketTypeSummary(items){
  const counts = {};
  for(const it of (Array.isArray(items) ? items : [])){
    const name = String((it && it.name) || "Ticket");
    counts[name] = (counts[name] || 0) + Number((it && it.quantity) || 0);
  }
  return Object.keys(counts).map(k => counts[k] + " x " + k).join(", ");
}
/* Base64 without btoa, so the identical code runs in a Worker and in the
   preview harness. Used for Brevo attachments (the ticket QR images). */
const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64Encode(input){
  const bytes = (input instanceof Uint8Array) ? input : new Uint8Array(input || []);
  let out = "";
  for(let i = 0; i < bytes.length; i += 3){
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += B64_TABLE[b0 >> 2];
    out += B64_TABLE[((b0 & 3) << 4) | (b1 == null ? 0 : b1 >> 4)];
    out += b1 == null ? "=" : B64_TABLE[((b1 & 15) << 2) | (b2 == null ? 0 : b2 >> 6)];
    out += b2 == null ? "=" : B64_TABLE[b2 & 63];
  }
  return out;
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function validEmail(value){
  const s = String(value == null ? "" : value).trim();
  if(!EMAIL_RE.test(s) || s.length > 190) return null;
  return s.toLowerCase();
}
/* Subjects are a single header line: CR/LF would allow header injection, and
   a very long subject is truncated by clients anyway. */
function safeSubject(value, fallback){
  const s = String(value == null ? "" : value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return (s || fallback || BRAND.product).slice(0, 180);
}
/* Brand values come from app_settings when the owner has set them, otherwise
   from this file. Never from the browser. */
export function brandOf(settings){
  const s = settings || {};
  return {
    product: s.platform_name || BRAND.product,
    parent: s.brand_line || BRAND.parent,
    tagline: s.brand_tagline || BRAND.tagline,
    support_email: s.support_email || BRAND.support_email,
    support_phone: s.support_phone || BRAND.support_phone,
    website: s.public_base_url || BRAND.website
  };
}
/* ============================================================================
   DESIGN SYSTEM
   ----------------------------------------------------------------------------
   Every block is a nested <table role="presentation"> with inline styles.
   That is the only markup Outlook (Word rendering engine) honours reliably,
   and it keeps the layout intact when a client strips <style>.
   ========================================================================== */
const ALERT_STYLES = {
  ok:      { bg: COLORS.ok_bg,   ink: COLORS.ok_ink,   border: "#A7F3D0", glyph: "&#10003;" },
  warn:    { bg: COLORS.warn_bg, ink: COLORS.warn_ink, border: "#FDE68A", glyph: "!" },
  err:     { bg: COLORS.err_bg,  ink: COLORS.err_ink,  border: "#FECACA", glyph: "!" },
  info:    { bg: COLORS.info_bg, ink: COLORS.info_ink, border: "#C7D2FE", glyph: "i" },
  neutral: { bg: COLORS.soft,    ink: COLORS.body,     border: COLORS.line, glyph: "-" }
};
function alertStyle(kind){ return ALERT_STYLES[kind] || ALERT_STYLES.neutral; }
export function pill(text, kind){
  const c = alertStyle(kind);
  if(!text) return "";
  return '<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:' + c.bg +
    ';color:' + c.ink + ';font:700 11px/1.4 ' + EMAIL_FONT + ';letter-spacing:.04em;text-transform:uppercase">' +
    esc(text) + "</span>";
}
export function button(label, url, kind){
  if(!label || !url) return "";
  const primary = kind !== "ghost";
  const bg = primary ? COLORS.primary : "#FFFFFF";
  const fg = primary ? "#FFFFFF" : COLORS.primary;
  const border = primary ? COLORS.primary : "#C7D2FE";
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">' +
    '<tr><td align="center" bgcolor="' + bg + '" class="btn-sm" style="border-radius:10px;border:1px solid ' + border + '">' +
    '<a href="' + esc(url) + '" style="display:inline-block;padding:13px 22px;font:700 15px/1.2 ' + EMAIL_FONT +
    ';color:' + fg + ';text-decoration:none;border-radius:10px">' + esc(label) + "</a></td></tr></table>";
}
export function buttonRow(list){
  const items = (list || []).filter(b => b && b.label && b.url);
  if(!items.length) return "";
  const cells = items.map(b => '<td class="stack" align="left" style="padding:0 10px 10px 0">' + button(b.label, b.url, b.kind) + "</td>").join("");
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' + cells + "</tr></table>";
}
export function alertBox(kind, title, text){
  const c = alertStyle(kind);
  const head = title
    ? '<div style="font:700 15px/1.4 ' + EMAIL_FONT + ';color:' + c.ink + ';margin:0 0 4px">' + esc(title) + "</div>"
    : "";
  const body = text
    ? '<div style="font:400 14px/1.6 ' + EMAIL_FONT + ';color:' + COLORS.body + ';margin:0">' + esc(text) + "</div>"
    : "";
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px">' +
    '<tr><td bgcolor="' + c.bg + '" style="background:' + c.bg + ";border:1px solid " + c.border +
    ';border-left:4px solid ' + c.ink + ';border-radius:12px;padding:14px 16px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
    '<td width="22" valign="top" style="font:700 15px/1.4 ' + EMAIL_FONT + ';color:' + c.ink + '">' + c.glyph + "</td>" +
    "<td>" + head + body + "</td></tr></table></td></tr></table>";
}
export function noteBox(text){
  if(!text) return "";
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px">' +
    '<tr><td bgcolor="' + COLORS.soft + '" style="background:' + COLORS.soft + ";border:1px solid " + COLORS.line +
    ';border-radius:12px;padding:14px 16px;font:400 14px/1.6 ' + EMAIL_FONT + ";color:" + COLORS.body + '">' + text + "</td></tr></table>";
}
/* Label / value rows, used for order and event details. */
export function detailTable(rows){
  const list = (rows || []).filter(r => r && r[0] != null && r[1] != null && String(r[1]) !== "");
  if(!list.length) return "";
  const body = list.map(r =>
    '<tr><td style="padding:7px 0;font:400 14px/1.5 ' + EMAIL_FONT + ';color:' + COLORS.muted + ';vertical-align:top">' + esc(r[0]) + "</td>" +
    '<td align="right" style="padding:7px 0;font:600 14px/1.5 ' + EMAIL_FONT + ";color:" + COLORS.ink + ';vertical-align:top">' + esc(r[1]) + "</td></tr>"
  ).join("");
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' + body + "</table>";
}
/* Order items + total. Prices are snapshots the Worker took from D1. */
export function lineItemsTable(items, currency, opts){
  const o = opts || {};
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if(!list.length) return "";
  const th = 'font:700 11px/1.4 ' + EMAIL_FONT + ';color:' + COLORS.faint + ';letter-spacing:.06em;text-transform:uppercase';
  const head = "<tr>" +
    '<td style="padding:0 0 8px;' + th + '">Item</td>' +
    '<td align="center" style="padding:0 0 8px;' + th + '">Qty</td>' +
    '<td align="right" style="padding:0 0 8px;' + th + '">Amount</td>' +
    "</tr>";
  const rows = list.map(it => {
    const unit = Number(it.unit_price);
    const sub = Number(it.subtotal);
    const amount = Number.isFinite(sub) ? sub : (unit * Number(it.quantity || 0));
    const unitNote = Number.isFinite(unit) && Number(it.quantity) > 1
      ? '<div style="font:400 12px/1.4 ' + EMAIL_FONT + ";color:" + COLORS.faint + '">' + esc(money(unit, currency)) + " each</div>"
      : "";
    return "<tr>" +
      '<td style="padding:9px 0;border-top:1px solid ' + COLORS.line + ';font:600 14px/1.5 ' + EMAIL_FONT + ";color:" + COLORS.ink + '">' + esc(it.name || "Ticket") + unitNote + "</td>" +
      '<td align="center" style="padding:9px 0;border-top:1px solid ' + COLORS.line + ';font:400 14px/1.5 ' + EMAIL_FONT + ";color:" + COLORS.body + '">' + esc(String(it.quantity == null ? "" : it.quantity)) + "</td>" +
      '<td align="right" style="padding:9px 0;border-top:1px solid ' + COLORS.line + ';font:600 14px/1.5 ' + EMAIL_FONT + ";color:" + COLORS.ink + '">' + esc(money(amount, currency)) + "</td>" +
      "</tr>";
  }).join("");
  const rule = "border-top:2px solid " + COLORS.ink;
  const totalRow = o.total == null ? "" : "<tr>" +
    '<td style="padding:12px 0 0;' + rule + ';font:700 15px/1.5 ' + EMAIL_FONT + ";color:" + COLORS.ink + '">' + esc(o.total_label || "Total paid") + "</td>" +
    '<td style="padding:12px 0 0;' + rule + '"></td>' +
    '<td align="right" style="padding:12px 0 0;' + rule + ';font:700 16px/1.5 ' + EMAIL_FONT + ";color:" + COLORS.ink + '">' + esc(money(o.total, currency)) + "</td></tr>";
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' + head + rows + totalRow + "</table>";
}
function sectionTitle(text){
  if(!text) return "";
  return '<div style="font:700 16px/1.4 ' + EMAIL_FONT + ';color:' + COLORS.ink + ';margin:24px 0 10px">' + esc(text) + "</div>";
}
/* --------------------------------------------------------------- cards ----- */
function surface(inner, pad){
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px">' +
    '<tr><td bgcolor="#FFFFFF" style="background:#FFFFFF;border:1px solid ' + COLORS.line +
    ";border-radius:14px;padding:" + (pad || "18px") + '">' + inner + "</td></tr></table>";
}
const BULLET = '<span style="color:' + COLORS.primary + ';font-weight:700">&#9679;</span> ';
function detailLine(label, value){
  if(!value) return "";
  return '<div style="font:400 14px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.body + '">' + BULLET +
    '<span style="color:' + COLORS.muted + '">' + esc(label) + "</span> " +
    '<strong style="color:' + COLORS.ink + '">' + esc(value) + "</strong></div>";
}
/* Event summary: poster on the left, the facts on the right. The two cells
   become one column below 620px (class="stack"). */
export function eventCard(ev, opts){
  const e = ev || {};
  const o = opts || {};
  if(!e.title && !e.venue && !e.date) return "";
  const poster = /^https?:\/\//i.test(String(e.poster_url || ""))
    ? '<img src="' + esc(e.poster_url) + '" width="168" alt="' + esc(e.title || "Event poster") +
      '" class="stack-img" style="display:block;width:168px;height:auto;max-width:100%;border-radius:12px;border:1px solid ' + COLORS.line + '" />'
    : "";
  const when = [e.date ? fmtDate(e.date) : "", e.time ? fmtTime(e.time) : (e.start_time ? fmtTime(e.start_time) : "")].filter(Boolean).join(", ");
  const where = [e.venue, e.location].filter(Boolean).join(", ");
  const facts = detailLine("When", when) + detailLine("Where", where) +
    detailLine("Organizer", e.organizer_name || e.organizer) +
    detailLine("Category", e.category);
  const left = poster
    ? '<td width="168" valign="top" class="stack" style="padding:0 16px 12px 0">' + poster + "</td>"
    : "";
  const right = '<td valign="top" class="stack" style="padding:0 0 12px">' +
    '<div style="font:700 17px/1.4 ' + EMAIL_FONT + ';color:' + COLORS.ink + ';margin:0 0 8px">' + esc(e.title || "Your event") + "</div>" +
    facts + "</td>";
  const body = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' + left + right + "</tr></table>" +
    (o.note ? '<div style="font:400 13px/1.6 ' + EMAIL_FONT + ";color:" + COLORS.muted + '">' + esc(o.note) + "</div>" : "");
  return surface(body);
}
/* One ticket = one scannable QR. qr_url is the Worker route that renders the
   PNG, so the image always matches the row in D1. */
export function ticketCard(t, opts){
  const tk = t || {};
  const o = opts || {};
  const number = tk.number || tk.ticket_number || "";
  const type = tk.type || tk.ticket_type_name || "Ticket";
  const qr = /^https?:\/\//i.test(String(tk.qr_url || ""))
    ? '<img src="' + esc(tk.qr_url) + '" width="150" height="150" alt="QR code for ticket ' + esc(number) +
      '" style="display:block;width:150px;height:150px;border:1px solid ' + COLORS.line + ';border-radius:12px;background:#FFFFFF" />'
    : '<div style="width:150px;height:150px;border:1px dashed ' + COLORS.line + ';border-radius:12px;background:' + COLORS.soft +
      ";font:700 11px/1.5 " + EMAIL_MONO + ";color:" + COLORS.faint + ';text-align:center;padding-top:56px;box-sizing:border-box">QR CODE<br />AVAILABLE<br />ONLINE</div>';
  const rows = [
    ["Ticket number", number],
    ["Attendee", tk.attendee || tk.attendee_name],
    ["Ticket type", type],
    ["Status", tk.status ? String(tk.status).toUpperCase() : "VALID"]
  ];
  const head = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
    '<td valign="middle" style="font:700 15px/1.4 ' + EMAIL_FONT + ';color:' + COLORS.ink + '">' + esc(type) +
    (o.index ? ' <span style="font:400 12px/1.4 ' + EMAIL_FONT + ";color:" + COLORS.faint + '">(' + esc(o.index) + ")</span>" : "") + "</td>" +
    '<td align="right" valign="middle">' + pill("Admit one", "info") + "</td></tr></table>";
  const perforation = '<div style="border-top:2px dashed #D1D5DB;margin:14px 0;font-size:0;line-height:0">&nbsp;</div>';
  const left = '<td width="164" valign="top" class="stack" style="padding:0 16px 12px 0">' + qr + "</td>";
  const right = '<td valign="top" class="stack" style="padding:0 0 12px">' +
    detailTable(rows) +
    (o.button ? '<div style="margin-top:14px">' + button(o.button_label || "View / print ticket", o.button, "ghost") + "</div>" : "") +
    "</td>";
  const body = head + perforation +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' + left + right + "</tr></table>" +
    (o.footnote ? '<div style="font:400 12px/1.6 ' + EMAIL_FONT + ";color:" + COLORS.muted + '">' + esc(o.footnote) + "</div>" : "");
  return surface(body, "18px");
}
export function steps(list){
  const items = (list || []).filter(Boolean);
  if(!items.length) return "";
  const rows = items.map((text, i) => '<tr>' +
    '<td width="28" valign="top" style="padding:0 0 10px;font:700 13px/1.6 ' + EMAIL_FONT + ";color:" + COLORS.primary + '">' + (i + 1) + ".</td>" +
    '<td valign="top" style="padding:0 0 10px;font:400 14px/1.6 ' + EMAIL_FONT + ";color:" + COLORS.body + '">' + esc(text) + "</td></tr>").join("");
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' + rows + "</table>";
}
/* ============================================================================
   DOCUMENT SHELL
   ----------------------------------------------------------------------------
   600px container, gradient brand bar, content card and a footer that always
   carries a support route. .stack / .pad collapse the layout on small screens;
   everything else is inline so a client that strips <style> (or Outlook) still
   renders the same card.
   ========================================================================== */
const MEDIA_CSS = "@media only screen and (max-width:620px){" +
  ".wrap{width:100% !important;border-radius:14px !important;}" +
  ".pad{padding-left:18px !important;padding-right:18px !important;}" +
  ".stack{display:block !important;width:100% !important;max-width:100% !important;padding:0 0 12px 0 !important;}" +
  ".stack-img{width:100% !important;height:auto !important;}" +
  ".center-sm{text-align:center !important;}" +
  ".btn-sm{display:block !important;}" +
  ".btn-sm a{display:block !important;padding:14px 16px !important;}" +
  ".hide-sm{display:none !important;}" +
  "}";
function brandHeader(brand, chip){
  return '<tr><td bgcolor="' + COLORS.soft + '" class="pad" style="background:' + COLORS.soft + ';border-bottom:1px solid ' + COLORS.line + ';padding:18px 26px 16px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
    '<td valign="middle">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td width="34" valign="middle"><div style="width:34px;height:34px;border-radius:10px;background:' + COLORS.primary + ';opacity:.12;border:1px solid rgba(76,111,255,.18);text-align:center;font:800 12px/34px ' + EMAIL_FONT + ';color:' + COLORS.primary + ';letter-spacing:.04em">T</div></td>' +
      '<td valign="middle" style="padding-left:12px">' +
        '<div style="font:700 16px/1.3 ' + EMAIL_FONT + ';color:' + COLORS.ink + '">' + esc(brand.product) + "</div>" +
        (brand.tagline ? '<div style="font:400 11px/1.4 ' + EMAIL_FONT + ';color:' + COLORS.muted + '">' + esc(brand.tagline) + "</div>" : "") +
      "</td></tr></table>" +
    "</td>" +
    '<td align="right" valign="middle" class="hide-sm"><span style="display:inline-block;padding:6px 10px;border-radius:999px;background:#FFFFFF;border:1px solid ' + COLORS.line + ';font:700 10px/1.2 ' + EMAIL_FONT + ';color:' + COLORS.primary + ';letter-spacing:.06em;text-transform:uppercase">' + esc(chip || "Update") + "</span></td>" +
    "</tr></table></td></tr>";
}
function brandFooter(brand, links, legal){
  const helpLine = brand.support_email
    ? '<div style="font:400 13px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.body + '">Questions about this email? Write to <a href="mailto:' +
      esc(brand.support_email) + '" style="color:' + COLORS.primary + ';font-weight:600">' + esc(brand.support_email) + "</a>" +
      (brand.support_phone ? " or call " + esc(brand.support_phone) : "") + ".</div>"
    : "";
  const navItems = [
    ["Browse events", linkOf(links, "events", "")],
    ["My tickets", linkOf(links, "order", "")],
    ["Dashboard", linkOf(links, "organizer", "")],
    ["Terms", linkOf(links, "terms", "")],
    ["Privacy", linkOf(links, "privacy", "")],
    ["Website", /^https?:\/\//i.test(String(brand.website || "")) ? brand.website : ""]
  ].filter(p => p[1]);
  const nav = navItems.length
    ? '<div style="font:400 12px/1.9 ' + EMAIL_FONT + ';color:' + COLORS.muted + '">' + navItems.map(p =>
        '<a href="' + esc(p[1]) + '" style="color:' + COLORS.primary + ';text-decoration:none">' + esc(p[0]) + "</a>").join(' <span style="color:#C5CEDB">&middot;</span> ') + "</div>"
    : "";
  return '<tr><td bgcolor="#FFFFFF" class="pad" style="background:#FFFFFF;border-top:1px solid ' + COLORS.line + ';padding:20px 26px 24px">' +
    helpLine +
    '<div style="margin:10px 0 8px">' + nav + "</div>" +
    '<div style="font:400 11px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.faint + '">' + esc(legal || ("You are receiving this email because of your activity on " + brand.product + ".")) + "</div>" +
    '<div style="font:400 11px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.faint + '>&copy; ' + new Date().getUTCFullYear() + " " + esc(brand.product) + "</div>" +
    "</td></tr>";
}
function linkOf(links, key, fallback){
  const url = links && links[key] ? String(links[key]) : "";
  return /^https?:\/\//i.test(url) ? url : (fallback || "");
}
/* ============================================================================
   LEGACY .html PAGE LINKS
   ----------------------------------------------------------------------------
   Pages moved from /ticket.html to the folder URL /ticket/. The outbox stores
   the BUILT links inside payload_json at QUEUE time and re-renders the document
   from that stored copy, so template fixes apply to a queued row but the link
   VALUES do not: a row queued before the move still holds the old .html shape
   and ships it again on every resend. These helpers fold the old shape back onto
   the current folder URLs, so a re-armed row goes out clean. The names mirror
   LEGACY_PAGE_RE in the Worker, and the (?=[?#]|$) guard means only whole page
   links are touched - never a filename that merely ends in .html. owner-login
   is the one exception: that page was retired, so it folds onto /login/.
   ========================================================================== */
const LEGACY_PAGE_URL_RE = /\/(organizer-dashboard|organizer-events|organizer-settings|owner-dashboard|owner-events|owner-login|owner-orders|owner-organizers|owner-settings|payment-failed|payment-success|sell-your-tickets|ticket-types|create-event|edit-event|check-in|forgot-password|attendees|checkout|contact|events|index|login|orders|organizer|owner|privacy|register|terms|ticket|event)\.html(?=[?#]|$)/g;
function foldLegacyPageUrl(value){
  const s = String(value == null ? "" : value);
  if(!s || s.indexOf(".html") === -1) return value;
  return s.replace(LEGACY_PAGE_URL_RE, (m, name) => name === "index" ? "/" : (name === "owner-login" ? "/login/" : "/" + name + "/"));
}
function foldLinkMap(links){
  const out = links && typeof links === "object" ? links : {};
  for(const key in out){
    if(typeof out[key] === "string") out[key] = foldLegacyPageUrl(out[key]);
  }
  return out;
}
/* Folds every link slot a stored payload can carry: the named links map, the
   event page URL and any per-ticket button URL. Mutates and returns the payload
   so a caller can use it in place. */
export function normalisePayloadLinks(payload){
  const p = payload || {};
  if(p.links) p.links = foldLinkMap(p.links);
  if(p.event && typeof p.event.url === "string") p.event.url = foldLegacyPageUrl(p.event.url);
  if(Array.isArray(p.tickets)){
    for(const t of p.tickets){
      if(t && typeof t === "object" && typeof t.ticket_url === "string"){
        t.ticket_url = foldLegacyPageUrl(t.ticket_url);
      }
    }
  }
  return p;
}
/* Rebuilds a links map for a message sent from the owner console: the freshly
   built folder URLs win, but only where they actually have a value (emailLinks
   returns event:"" with no event), so a stored link is never blanked out. */
export function mergeEmailLinks(stored, fresh){
  const out = Object.assign({}, stored || {});
  for(const key in (fresh || {})){
    if(fresh[key]) out[key] = fresh[key];
  }
  return foldLinkMap(out);
}
export function emailShell(o){
  const opts = o || {};
  const brand = opts.brand || brandOf(null);
  const links = opts.links || {};
  const stub = opts.stub
    ? '<tr><td style="padding:0;background:#FFFFFF;font-size:0;line-height:0"><div style="border-top:2px dashed #D1D5DB;font-size:0;line-height:0">&nbsp;</div></td></tr>'
    : "";
  const heroBits = (opts.badge ? '<div style="margin:0 0 10px">' + pill(opts.badge.text, opts.badge.kind) + "</div>" : "") +
    (opts.heading ? '<h1 style="margin:0 0 8px;font:700 24px/1.3 ' + EMAIL_FONT + ';color:' + COLORS.ink + ';letter-spacing:-.01em">' + esc(opts.heading) + "</h1>" : "") +
    (opts.subheading ? '<p style="margin:0;font:400 15px/1.6 ' + EMAIL_FONT + ";color:" + COLORS.muted + '">' + esc(opts.subheading) + "</p>" : "");
  const hero = heroBits ? '<tr><td class="pad" style="padding:30px 26px 8px">' + heroBits + "</td></tr>" : "";
  const content = '<tr><td class="pad" style="padding:12px 26px 6px">' + (opts.content || "") + "</td></tr>";
  const preheader = opts.preheader
    ? '<div style="display:none;font-size:1px;color:' + COLORS.bg + ';line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">' + esc(opts.preheader) + "</div>"
    : "";
  return '<!DOCTYPE html>\n<html lang="en" dir="ltr">\n<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />\n' +
    '<meta name="x-apple-disable-message-reformatting" />\n' +
    '<meta name="color-scheme" content="light" />\n' +
    '<meta name="supported-color-schemes" content="light" />\n' +
    "<title>" + esc(opts.title || opts.heading || brand.product) + "</title>\n" +
    "<style>" + MEDIA_CSS + "</style>\n</head>\n" +
    '<body style="margin:0;padding:0;background:' + COLORS.bg + ';-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">' +
    preheader +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + COLORS.bg + '" style="background:' + COLORS.bg + '">' +
    '<tr><td align="center" style="padding:26px 12px">' +
    '<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:16px;border:1px solid ' + COLORS.line + '">' +
    brandHeader(brand, opts.chip) + stub + hero + content + brandFooter(brand, links, opts.legal) +
    "</table></td></tr></table></body></html>";
}
/* Plain-text alternative: some clients (and many corporate filters) prefer it,
   and it is a deliverability signal. Same information, no markup. */
export function plainText(o){
  const opts = o || {};
  const brand = opts.brand || brandOf(null);
  const links = opts.links || {};
  const parts = [brand.product.toUpperCase() + " - " + brand.parent, ""];
  if(opts.heading) parts.push(opts.heading.toUpperCase(), "");
  for(const block of (opts.blocks || [])) if(block) parts.push(String(block), "");
  const urls = [["Open my tickets", linkOf(links, "order", "")], ["Event page", linkOf(links, "event", "")],
    ["Organizer dashboard", linkOf(links, "organizer", "")], ["Browse events", linkOf(links, "events", "")],
    ["Support", linkOf(links, "support", "")]].filter(p => p[1]);
  if(urls.length){
    parts.push("LINKS");
    for(const p of urls) parts.push("- " + p[0] + ": " + p[1]);
    parts.push("");
  }
  if(brand.support_email) parts.push("Need help? " + brand.support_email + (brand.support_phone ? " | " + brand.support_phone : ""), "");
  parts.push(opts.legal || ("You are receiving this email because of your activity on " + brand.product + "."));
  parts.push("(c) " + new Date().getUTCFullYear() + " " + brand.product + " - " + brand.parent);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function textRows(rows){
  return (rows || []).filter(r => r && r[0] != null && r[1] != null && String(r[1]) !== "")
    .map(r => r[0] + ": " + r[1]).join("\n");
}

/* ============================================================================
   PAYLOAD NORMALISATION
   ----------------------------------------------------------------------------
   A template must never throw because a field is missing: the Worker builds the
   payload, but an email queued by an earlier deployment, or a hand-written
   owner broadcast, can be thinner. Everything is normalised once, here.
   ========================================================================== */
function normalise(payload){
  const p = payload || {};
  const links = p.links || {};
  const rawEvent = p.event || {};
  const order = p.order || {};
  const tickets = (Array.isArray(p.tickets) ? p.tickets : []).filter(Boolean).map(t => {
    const number = t.number || t.ticket_number || "";
    return {
      number: number,
      type: t.type || t.ticket_type_name || "Ticket",
      attendee: t.attendee || t.attendee_name || (p.customer && p.customer.name) || "",
      status: t.status || "valid",
      qr_url: t.qr_url || "",
      qr_base64: t.qr_base64 || "",
      ticket_url: t.ticket_url || (links.ticket_base && number ? links.ticket_base + encodeURIComponent(number) : "")
    };
  });
  const items = (Array.isArray(p.items) ? p.items : []).filter(Boolean).map(it => ({
    name: it.name || it.ticket_type_name || "Ticket",
    quantity: it.quantity,
    unit_price: it.unit_price,
    subtotal: it.subtotal
  }));
  return {
    brand: p.brand || brandOf(null),
    links: links,
    customer: p.customer || {},
    order: {
      number: order.number || order.order_number || order.reference || "",
      reference: order.reference || order.payment_reference || order.number || order.order_number || "",
      status: order.status || "",
      currency: order.currency || "KES",
      amount: order.amount == null ? order.total_amount : order.amount,
      paid_at: order.paid_at || "",
      created_at: order.created_at || "",
      provider_label: order.provider_label || "",
      note: order.note || ""
    },
    event: {
      title: rawEvent.title || "",
      category: rawEvent.category || "",
      date: rawEvent.date || rawEvent.event_date || "",
      time: rawEvent.time || rawEvent.start_time || "",
      end_time: rawEvent.end_time || "",
      venue: rawEvent.venue || "",
      location: rawEvent.location || "",
      poster_url: rawEvent.poster_url || rawEvent.poster || "",
      organizer_name: rawEvent.organizer_name || rawEvent.organizer || "",
      organizer_email: rawEvent.organizer_email || "",
      organizer_phone: rawEvent.organizer_phone || "",
      url: rawEvent.url || linkOf(links, "event", "")
    },
    items: items,
    tickets: tickets,
    /* Legacy rows queued by an earlier build stored the contact body as a plain
       string at payload.message; both shapes are accepted forever. */
    message: (p.message && typeof p.message === "object") ? p.message : {
      name: p.name || "",
      email: p.from_email || "",
      phone: p.phone || "",
      subject: p.subject || "",
      body: typeof p.message === "string" ? p.message : (p.body || ""),
      sent_at: p.sent_at || ""
    },
    reason: p.reason || "",
    meta: p.meta || {}
  };
}
function eventWhen(ev){
  return [ev.date ? fmtDate(ev.date) : "", ev.time ? fmtTime(ev.time) : ""].filter(Boolean).join(", ");
}
function eventWhere(ev){
  return [ev.venue, ev.location].filter(Boolean).join(", ");
}
function ticketCountLabel(n){
  return (Number(n) === 1 ? "1 ticket" : Number(n) + " tickets");
}
function ticketBlocks(ctx){
  const orderUrl = linkOf(ctx.links, "order", "");
  return ctx.tickets.map((t, i) => ticketCard(t, {
    index: ctx.tickets.length > 1 ? ("Ticket " + (i + 1) + " of " + ctx.tickets.length) : "",
    button: t.ticket_url || orderUrl,
    button_label: "View / print ticket",
    footnote: (i === ctx.tickets.length - 1 && ctx.tickets.length > 1)
      ? "Every ticket above carries its own QR code and is scanned once at the gate."
      : ""
  })).join("");
}

/* ============================================================================
   TEMPLATE: ticket_ready / ticket_resend
   ----------------------------------------------------------------------------
   Confirmation + receipt + entry pass in one email. Sent the moment a payment
   is verified (or a free order is settled), and re-sent on demand from
   ticket.html / payment-success.html.
   ========================================================================== */
function ticketSubject(p){
  const ctx = normalise(p);
  return ctx.tickets.length > 1
    ? "Your " + ctx.tickets.length + " tickets for " + (ctx.event.title || "your event")
    : "Your ticket for " + (ctx.event.title || "your event");
}
function resendSubject(p){
  const ctx = normalise(p);
  return "Resent: your ticket" + (ctx.tickets.length > 1 ? "s" : "") + " for " + (ctx.event.title || "your event");
}
function ticketBody(payload, mode){
  const ctx = normalise(payload);
  const ev = ctx.event, order = ctx.order;
  const total = money(order.amount, order.currency);
  const resend = mode === "resend";
  const heading = resend
    ? "Your ticket" + (ctx.tickets.length > 1 ? "s" : "") + ", resent"
    : "You are in, " + firstName(ctx.customer.name) + "!";
  const subheading = resend
    ? (ev.title ? ev.title + (ev.date ? " - " + fmtDate(ev.date) : "") : "Here are the tickets issued for your order.")
    : (ev.title
        ? "Your payment was confirmed and your " + ticketCountLabel(ctx.tickets.length) + " for " + ev.title +
          (ctx.tickets.length > 1 ? " are" : " is") + " ready."
        : "Your payment was confirmed and your tickets are ready.");
  const lead = resend
    ? alertBox("info", "Requested resend", "This is a copy of the tickets issued to order " + (order.number || "-") +
        ". A copy never creates new tickets - the existing QR codes stay valid.")
    : alertBox("ok", "Payment confirmed", total + " received" + (order.provider_label ? " via " + order.provider_label : "") +
        ". Your tickets are below - keep this email, the QR codes are your entry pass.");
  const gate = "Open the QR code on your phone or print this email. Each code is scanned once at the gate and is rejected if it has already been used, " +
    "so forwarded screenshots cannot be reused. Bring an ID that matches the ticket name if the organizer asks for one.";
  const content = lead +
    eventCard(ev, { note: ev.url ? "Event page: " + ev.url : "" }) +
    sectionTitle(ctx.tickets.length > 1 ? ("Your " + ctx.tickets.length + " tickets") : "Your ticket") +
    ticketBlocks(ctx) +
    sectionTitle("Order summary") +
    lineItemsTable(ctx.items, order.currency, { total: order.amount, total_label: "Total paid" }) +
    '<div style="height:14px"></div>' +
    detailTable([
      ["Order number", order.number],
      ["Payment reference", order.reference],
      ["Paid on", fmtDateTime(order.paid_at)],
      ["Ticket holder", ctx.customer.name],
      ["Email", ctx.customer.email]
    ]) +
    sectionTitle("At the gate") +
    noteBox(esc(gate)) +
    steps([
      "Open the QR code on your phone, or print this email and bring it along.",
      "Arrive at " + (eventWhere(ev) || "the venue") + (ev.date ? " on " + fmtShortDate(ev.date) : "") + (ev.time ? " from " + fmtTime(ev.time) : "") + ".",
      "Show the code at the entrance - it is scanned once per ticket.",
      "Keep the ticket number" + (ctx.tickets[0] ? " " + ctx.tickets[0].number : "") + " for support."
    ]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Open my tickets", url: linkOf(ctx.links, "order", "") },
      { label: "Event details", url: ev.url, kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Your tickets", stub: true,
    preheader: (ev.title || "Your tickets") + " - " + ticketCountLabel(ctx.tickets.length) + " confirmed" +
      (order.number ? ", order " + order.number : ""),
    badge: { text: ticketCountLabel(ctx.tickets.length), kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "This email contains your entry codes. Keep it until the event is over."
  });
  const ticketText = ctx.tickets.map(t => textRows([
    ["Ticket number", t.number], ["Ticket type", t.type], ["Attendee", t.attendee], ["QR image", t.qr_url]
  ])).join("\n\n");
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "This email contains your entry codes. Keep it until the event is over.",
    blocks: [
      resend
        ? ("Copy of the tickets issued to order " + (order.number || "-") + ".")
        : ("Payment confirmed: " + total + " received" + (order.provider_label ? " via " + order.provider_label : "") + "."),
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)], ["Organizer", ev.organizer_name]])) : "",
      ticketText ? ("TICKETS\n" + ticketText) : "",
      "ORDER\n" + textRows([["Order number", order.number], ["Payment reference", order.reference],
        ["Total paid", total], ["Paid on", fmtDateTime(order.paid_at)], ["Ticket holder", ctx.customer.name]]),
      "AT THE GATE\n" + gate
    ]
  });
  return { subject: resend ? resendSubject(payload) : ticketSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: order_pending
   ----------------------------------------------------------------------------
   Sent when an order is created but the payment is not confirmed yet, so an
   abandoned checkout always has a written trail and the buyer can see that
   nothing was charged.
   ========================================================================== */
function orderPendingSubject(p){
  const ctx = normalise(p);
  return "Complete your order for " + (ctx.event.title || "your event") + (ctx.order.number ? " (" + ctx.order.number + ")" : "");
}
function orderPendingBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event, order = ctx.order;
  const total = money(order.amount, order.currency);
  const heading = "Your order is waiting";
  const subheading = ev.title
    ? "We reserved " + ticketCountLabel(totalQuantity(ctx.items)) + " for " + ev.title + ". The reservation is released if the payment is not completed."
    : "We reserved your tickets. The reservation is released if the payment is not completed.";
  const content =
    alertBox("warn", "Payment not confirmed yet", "Order " + (order.number || "-") + " was created for " + total +
      ", but no confirmed payment has reached us. No tickets have been issued yet.") +
    eventCard(ev) +
    sectionTitle("What you selected") +
    lineItemsTable(ctx.items, order.currency, { total: order.amount, total_label: "Amount due" }) +
    '<div style="height:14px"></div>' +
    steps([
      "Open the event page and choose your tickets again if the payment window has closed.",
      "Complete the payment on the provider page you are redirected to from checkout.",
      "Your tickets are emailed, and shown on screen, the moment the payment is confirmed.",
      "Already paid? Reply with the reference " + (order.reference || order.number || "-") + " and we will trace it."
    ]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Back to the event", url: ev.url },
      { label: "Contact support", url: linkOf(ctx.links, "support", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Order",
    preheader: "Order " + (order.number || "") + " was created but is not paid yet.",
    badge: { text: "Payment pending", kind: "warn" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because an order was started with this email address."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because an order was started with this email address.",
    blocks: [
      "Order " + (order.number || "-") + " is not paid yet. No tickets have been issued.",
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]])) : "",
      "ORDER\n" + textRows([["Order number", order.number], ["Amount due", total],
        ["Status", order.status || "pending"], ["Name", ctx.customer.name]]),
      "NEXT STEPS\nOpen the event page to buy again if the payment window closed. Contact support with the reference above if you already paid."
    ]
  });
  return { subject: orderPendingSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: payment_failed
   ----------------------------------------------------------------------------
   Sent when the provider reports a failed or abandoned payment: nothing was
   charged, nothing was issued, and here is exactly how to retry.
   ========================================================================== */
function paymentFailedSubject(p){
  const ctx = normalise(p);
  return "Payment not completed for " + (ctx.event.title || "your order");
}
function paymentFailedBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event, order = ctx.order;
  const total = money(order.amount, order.currency);
  const heading = "That payment did not go through";
  const subheading = "No tickets were issued and no confirmed charge was recorded. You can try again whenever you are ready.";
  const content =
    alertBox("err", "Payment not completed", "Order " + (order.number || "-") + " for " + total + " was not completed" +
      (ctx.reason ? " (" + ctx.reason + ")" : "") +
      ". If your bank shows a pending charge it is normally reversed automatically within a few minutes.") +
    eventCard(ev) +
    sectionTitle("Order details") +
    detailTable([
      ["Order number", order.number],
      ["Reference", order.reference],
      ["Amount", total],
      ["Created", fmtDateTime(order.created_at)],
      ["Status", "not paid"]
    ]) +
    '<div style="height:16px"></div>' +
    steps([
      "Try again on the event page and pick the same ticket types.",
      "If a card was declined, use another card, M-Pesa or your bank app.",
      "Still failing? Write to support with the reference " + (order.reference || order.number || "-") + "."
    ]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Try again", url: ev.url },
      { label: "Contact support", url: linkOf(ctx.links, "support", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Payment",
    preheader: "Nothing was charged for order " + (order.number || "") + ".",
    badge: { text: "Payment failed", kind: "err" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because a payment attempt was made with this email address."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because a payment attempt was made with this email address.",
    blocks: [
      "Order " + (order.number || "-") + " for " + total + " was not completed. No tickets were issued.",
      ctx.reason ? ("Reason: " + ctx.reason) : "",
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]])) : "",
      "HOW TO RETRY\nOpen the event page and choose your tickets again, or contact support with the reference above."
    ]
  });
  return { subject: paymentFailedSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: welcome
   ----------------------------------------------------------------------------
   Sent once, when an organizer finishes registration: the onboarding email.
   ========================================================================== */
function welcomeSubject(p){
  const ctx = normalise(p);
  return "Welcome to " + ctx.brand.product + (ctx.customer.name ? ", " + firstName(ctx.customer.name) : "") + " - your organizer account is ready";
}
function welcomeBody(payload){
  const ctx = normalise(payload);
  const heading = "Welcome aboard, " + firstName(ctx.customer.name) + "!";
  const subheading = "Your organizer account is ready - the four steps below take you from an empty dashboard to your first paid ticket.";
  const dash = linkOf(ctx.links, "organizer", "");
  const settings = linkOf(ctx.links, "settings", dash);
  const agreement = linkOf(ctx.links, "agreement", dash);
  const biz = (ctx.meta && ctx.meta.business_name) ? String(ctx.meta.business_name) : "";
  const content =
    alertBox("ok", "Account ready", (biz ? biz + " can now sell tickets" : "You can now sell tickets") +
      " as " + (ctx.customer.email || "your account email") + ". Everything below is managed from your dashboard - no paperwork, no setup fee.") +
    sectionTitle("Get set up in four steps") +
    steps([
      "Complete your profile: business name, logo and contact details, in Settings.",
      "Connect how you get paid in Settings > Payment Settings - see the box below.",
      "Sign the organizer agreement - required before an event can go live.",
      "Create your event and submit it for approval; we email you the moment it is live."
    ]) +
    sectionTitle("Set up payments (about two minutes)") +
    noteBox("<strong>Use your own merchant account.</strong> In Settings > Payment Settings pick <strong>Paystack</strong>, " +
      "<strong>Pesapal</strong> or <strong>PayHero</strong>, paste the API keys from your provider's dashboard, press " +
      "<strong>Test connection</strong>, then <strong>Make active</strong>. Keys are encrypted on our server and never shown again.") +
    noteBox("<strong>No merchant account yet?</strong> Switch on <strong>Owner payment mode</strong> in Settings: buyers pay the " +
      "platform and your share is paid out to you. You can also pick the payment mode per event while creating it.") +
    noteBox("<strong>Good to know.</strong> Buyers do not need an account. Every order, ticket and check-in is recorded for you, " +
      "attendee lists export to CSV, and the Check-in page scans QR tickets at the door.") +
    '<div style="height:6px"></div>' +
    buttonRow([
      { label: "Open my dashboard", url: dash },
      { label: "Payment settings", url: settings, kind: "ghost" },
      { label: "Sign agreement", url: agreement, kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Welcome",
    preheader: "Connect payments, sign the agreement and submit your first event.",
    badge: { text: "Account ready", kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because an organizer account was created with this address."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because an organizer account was created with this address.",
    blocks: [
      (biz ? biz + " is ready to sell tickets" : "Your organizer account is ready") + ". Signed in as " + (ctx.customer.email || "your account email") + ".",
      "GET SET UP\n1. Complete your profile in Settings (business name, logo, contact details).\n2. Connect payments in Settings > Payment Settings (see below).\n3. Sign the organizer agreement - required before an event can go live.\n4. Create your event and submit it for approval; we email you when it is live.",
      "SET UP PAYMENTS\n- Own merchant account: Settings > Payment Settings, choose Paystack, Pesapal or PayHero, paste your API keys, press Test connection, then Make active.\n- No merchant account? Switch on Owner payment mode in Settings: buyers pay the platform and your share is paid out to you. Each event can also pick its own payment mode." + (settings ? "\nPayment settings: " + settings : "") + (agreement ? "\nAgreement page: " + agreement : ""),
      "Buyers do not need an account. Orders, tickets and check-ins are recorded for you, attendee lists export to CSV, and the Check-in page scans QR tickets at the door."
    ]
  });
  return { subject: welcomeSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: new_sale  (organizer)
   ----------------------------------------------------------------------------
   Sent the moment a payment settles, so nobody has to refresh a dashboard to
   know that tickets are moving. Buyer contact details are included because
   organizers legitimately need them on the event day.
   ========================================================================== */
function newSaleSubject(p){
  const ctx = normalise(p);
  return "New sale: " + ticketTypeSummary(ctx.items) + " for " + (ctx.event.title || "your event");
}
function newSaleBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event, order = ctx.order;
  const total = money(order.amount, order.currency);
  const heading = "You made a sale";
  const subheading = ticketCountLabel(totalQuantity(ctx.items)) + " for " + (ev.title || "your event") + " - " + total + ".";
  const content =
    alertBox("ok", "Payment settled", "Order " + (order.number || "-") + " is paid" +
      (order.provider_label ? " through " + order.provider_label : "") + ". " +
      (ctx.tickets.length
        ? ctx.tickets.length + " ticket" + (ctx.tickets.length > 1 ? "s were" : " was") + " issued and emailed to the buyer."
        : "Tickets have been issued and emailed to the buyer.")) +
    sectionTitle("Order") +
    lineItemsTable(ctx.items, order.currency, { total: order.amount, total_label: "Order total" }) +
    '<div style="height:14px"></div>' +
    detailTable([
      ["Order number", order.number],
      ["Paid on", fmtDateTime(order.paid_at)],
      ["Buyer", ctx.customer.name],
      ["Buyer email", ctx.customer.email],
      ["Buyer phone", ctx.customer.phone]
    ]) +
    (ev.title ? sectionTitle("Event") + detailTable([["Event", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]]) : "") +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "View order", url: linkOf(ctx.links, "order", "") },
      { label: "Manage event", url: linkOf(ctx.links, "organizer", "") || ev.url, kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Sale",
    preheader: total + " received for " + (ev.title || "your event") + ".",
    badge: { text: "New sale", kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email as the organizer of this event."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email as the organizer of this event.",
    blocks: [
      "Payment settled: " + total + " for order " + (order.number || "-") + ".",
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]])) : "",
      "ORDER\n" + textRows([["Order number", order.number], ["Total", total], ["Paid on", fmtDateTime(order.paid_at)],
        ["Buyer", ctx.customer.name], ["Email", ctx.customer.email], ["Phone", ctx.customer.phone]]),
      ticketTypeSummary(ctx.items) ? ("TICKETS\n" + ticketTypeSummary(ctx.items)) : ""
    ]
  });
  return { subject: newSaleSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: contact_message  (support inbox + platform owners)  +  contact_ack
   ----------------------------------------------------------------------------
   The contact form writes to contact_messages in D1 and to this pair: one mail
   to the platform support address and to every active platform owner (so the
   people who can act always see it), one acknowledgement to the sender so nobody
   wonders whether the form worked.
   ========================================================================== */
function contactMessageSubject(p){
  const ctx = normalise(p);
  return "Contact form: " + (ctx.message.subject || ctx.message.name || "website message");
}
function contactMessageBody(payload){
  const ctx = normalise(payload);
  const msg = ctx.message;
  const body = esc(msg.body || "").replace(/\n/g, "<br />");
  const heading = "New contact form message";
  const subheading = "Sent from the " + ctx.brand.product + " contact page.";
  const content =
    alertBox("info", "Website enquiry", "A visitor submitted the contact form" + (msg.sent_at ? " on " + fmtDateTime(msg.sent_at) : "") +
      ". Replying directly to this email answers the sender.") +
    detailTable([
      ["Name", msg.name],
      ["Email", msg.email],
      ["Phone", msg.phone],
      ["Subject", msg.subject]
    ]) +
    (body ? sectionTitle("Message") + noteBox('<div style="white-space:normal">' + body + "</div>") : "") +
    '<div style="height:12px"></div>' +
    buttonRow([
      { label: "Reply by email", url: msg.email ? ("mailto:" + msg.email + "?subject=" + encodeURIComponent("Re: " + (msg.subject || "Your message"))) : "" },
      { label: "Open admin dashboard", url: linkOf(ctx.links, "owner", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Support",
    preheader: (msg.name || "A visitor") + " sent a message through the contact form.",
    badge: { text: "Contact form", kind: "info" },
    heading: heading, subheading: subheading, content: content,
    legal: "Internal notification from the " + ctx.brand.product + " contact form."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "Internal notification from the " + ctx.brand.product + " contact form.",
    blocks: [
      "FROM\n" + textRows([["Name", msg.name], ["Email", msg.email], ["Phone", msg.phone], ["Subject", msg.subject], ["Received", fmtDateTime(msg.sent_at)]]),
      "MESSAGE\n" + (msg.body || "")
    ]
  });
  return { subject: contactMessageSubject(payload), html: html, text: text };
}
function contactAckSubject(p){
  const ctx = normalise(p);
  return "We received your message - " + ctx.brand.product;
}
function contactAckBody(payload){
  const ctx = normalise(payload);
  const msg = ctx.message;
  const heading = "Thanks, " + firstName(msg.name) + " - we have your message";
  const subheading = "Our support team reads every message and normally replies within one business day.";
  const body = esc(msg.body || "").replace(/\n/g, "<br />");
  const content =
    alertBox("ok", "Message received", "We logged your message" + (msg.subject ? ' about "' + msg.subject + '"' : "") +
      ". Keep this email as your reference; replying to it adds to the same conversation.") +
    (body ? sectionTitle("What you sent us") + noteBox('<div style="white-space:normal">' + body + "</div>") : "") +
    sectionTitle("What happens next") +
    steps([
      "A support agent reads your message and checks the related order or event.",
      "You receive a reply at " + (msg.email || "this address") + " - check the spam folder too.",
      "Urgent on the event day? Show this email to the gate team for faster help."
    ]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Browse events", url: linkOf(ctx.links, "events", "") },
      { label: "Visit the help page", url: linkOf(ctx.links, "contact", linkOf(ctx.links, "support", "")), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Support",
    preheader: "We received your message and will reply within one business day.",
    badge: { text: "Received", kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because you used the contact form on " + ctx.brand.product + "."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because you used the contact form on " + ctx.brand.product + ".",
    blocks: [
      "We received your message" + (msg.subject ? (' about "' + msg.subject + '"') : "") + " on " + fmtDateTime(msg.sent_at) + ".",
      body ? ("YOUR MESSAGE\n" + msg.body) : "",
      "WHAT HAPPENS NEXT\nA support agent replies within one business day. Urgent on the event day? Show this email to the gate team."
    ]
  });
  return { subject: contactAckSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: event_cancelled
   ----------------------------------------------------------------------------
   Sent to every paid attendee (and to the organizer) when an event is
   cancelled. It never promises a refund on another party's behalf: refunds are
   issued by the organizer through the payment provider, so the email says who
   does what and how to ask for help.
   ========================================================================== */
function eventCancelledSubject(p){
  const ctx = normalise(p);
  return "Cancelled: " + (ctx.event.title || "your event");
}
function eventCancelledBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event, order = ctx.order;
  const who = ctx.meta && ctx.meta.recipient === "organizer";
  const heading = who ? "You cancelled " + (ev.title || "your event") : (ev.title || "This event") + " has been cancelled";
  const subheading = who
    ? "The event is now marked cancelled in the platform. Ticket sales and check-in are closed."
    : "The organizer cancelled this event, so the tickets issued for it are no longer valid for entry.";
  const reason = ctx.reason || "The organizer did not publish a reason.";
  const refundLine = who
    ? "Refund your buyers through the payment provider dashboard (Paystack or Pesapal). Their contact details are in the event's attendee list."
    : "If you paid for tickets, the organizer refunds the amount to the payer through the original payment channel. " +
      "Approved refunds normally reach a bank account or mobile wallet within 5 to 10 business days.";
  const content =
    alertBox("err", "Event cancelled", reason) +
    eventCard(ev) +
    sectionTitle("What this means") +
    noteBox(esc(refundLine)) +
    (ctx.tickets.length ? sectionTitle("Your tickets") + detailTable(ctx.tickets.map(t => [t.number, t.type])) : "") +
    (order.number ? sectionTitle("Your order") + detailTable([
      ["Order number", order.number],
      ["Amount paid", money(order.amount, order.currency)]
    ]) : "") +
    sectionTitle("Next steps") +
    steps(who
      ? ["Contact your buyers from the attendee list to confirm the refund.",
         "Reply to this email if you need help reaching a buyer.",
         "You can duplicate the event and publish a new date when you are ready."]
      : ["Reply to this email with your order number and we will follow up with the organizer.",
         "Keep this email - it is your proof of purchase for the cancelled event.",
         "Browse other events; your details are not shared with other organizers."]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Contact support", url: linkOf(ctx.links, "support", "") },
      { label: "Browse other events", url: linkOf(ctx.links, "events", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Event update",
    preheader: (ev.title || "The event") + " was cancelled.",
    badge: { text: "Cancelled", kind: "err" },
    heading: heading, subheading: subheading, content: content,
    legal: who ? "You received this email as the organizer of this event." : "You received this email because you bought a ticket for this event."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: who ? "You received this email as the organizer of this event." : "You received this email because you bought a ticket for this event.",
    blocks: [
      "Reason: " + reason,
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["Was due", eventWhen(ev)], ["Venue", eventWhere(ev)]])) : "",
      refundLine,
      ctx.tickets.length ? ("TICKETS\n" + ctx.tickets.map(t => t.number + " (" + t.type + ")").join("\n")) : "",
      order.number ? ("ORDER\n" + textRows([["Order number", order.number], ["Amount paid", money(order.amount, order.currency)]])) : ""
    ]
  });
  return { subject: eventCancelledSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: event_published  (organizer)
   ----------------------------------------------------------------------------
   Sent when an event becomes active, including when the platform owner
   approves it. This is the "go and share the link" moment.
   ========================================================================== */
function eventPublishedSubject(p){
  const ctx = normalise(p);
  return (ctx.event.title || "Your event") + " is live on " + ctx.brand.product;
}
function eventPublishedBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event;
  const heading = "Your event is live";
  const subheading = (ev.title || "Your event") + " is published and open for ticket sales.";
  const content =
    alertBox("ok", "Published", "The event page is public now. Ticket types you left active are on sale immediately; paused or hidden " +
      "types stay invisible until you switch them on.") +
    eventCard(ev) +
    sectionTitle("You can now") +
    steps([
      "Share " + (ev.url || "the public event link") + " on social media and WhatsApp.",
      "Watch sales in the dashboard - every confirmed payment raises a ticket and an email.",
      "Open the check-in page on the event day for gate scanning.",
      "Export the attendee list to CSV whenever you need it."
    ]) +
    noteBox("<strong>Tip.</strong> Give your gate team their own accounts and assign them to this event only: they can scan tickets, " +
      "but they cannot see your revenue or edit the event.") +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "View public page", url: ev.url },
      { label: "Manage event", url: linkOf(ctx.links, "organizer", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Event update",
    preheader: (ev.title || "Your event") + " is live - share the link.",
    badge: { text: "Live", kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email as the organizer of this event."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email as the organizer of this event.",
    blocks: [
      (ev.title || "Your event") + " is published and open for sales.",
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]])) : "",
      "Public link: " + (ev.url || "-"),
      "Watch sales in the dashboard: every confirmed payment raises a ticket and an email. The check-in page handles gate scanning."
    ]
  });
  return { subject: eventPublishedSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: event_pending_approval  (platform owner)
   ----------------------------------------------------------------------------
   An organizer submitting an event for publishing never goes live by itself:
   the Worker stores the event as "pending" and sends this mail to every active
   platform owner. It is the entry point of the approval queue, so it carries
   everything the reviewer needs (who submitted what, when and where) and one
   button straight into the review page.
   ========================================================================== */
function eventApprovalRequestSubject(p){
  const ctx = normalise(p);
  return "Approval needed: " + (ctx.event.title || "an event") + " is waiting to go live";
}
function eventApprovalRequestBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event;
  const meta = ctx.meta || {};
  const heading = "An event is waiting for your approval";
  const subheading = (ev.title || "An event") + (ev.organizer_name ? " by " + ev.organizer_name : "") +
    " was submitted for publishing and is NOT on sale yet.";
  const content =
    alertBox("warn", "Approval required",
      "Nothing is public yet: the event page, ticket sales and check-in stay closed until a platform owner approves it. " +
      "Approving publishes it immediately and emails the organizer.") +
    eventCard(ev) +
    sectionTitle("Who submitted it") +
    detailTable([
      ["Organizer", ev.organizer_name],
      ["Business email", ev.organizer_email],
      ["Phone", ev.organizer_phone],
      ["Submitted", meta.submitted_at ? fmtDateTime(meta.submitted_at) : ""]
    ]) +
    sectionTitle("The event as submitted") +
    detailTable([
      ["Title", ev.title],
      ["Category", ev.category],
      ["When", eventWhen(ev)],
      ["Where", eventWhere(ev)]
    ]) +
    sectionTitle("What happens next") +
    steps([
      "Open the events queue and check the details, poster and ticket types.",
      "Approve it to put it on sale now - the organizer is emailed the moment it is live.",
      "Send it back with a reason if something has to change first; nothing is public until it is approved."
    ]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Review this event", url: linkOf(ctx.links, "owner_events", linkOf(ctx.links, "owner", "")) },
      { label: "Open owner console", url: linkOf(ctx.links, "owner", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Event update",
    preheader: (ev.title || "An event") + " needs owner approval before it can go on sale.",
    badge: { text: "Awaiting approval", kind: "warn" },
    heading: heading, subheading: subheading, content: content,
    legal: "Internal notification for " + ctx.brand.product + " administrators."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "Internal notification for " + ctx.brand.product + " administrators.",
    blocks: [
      subheading,
      "EVENT\n" + textRows([["Title", ev.title], ["Category", ev.category], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]]),
      "SUBMITTED BY\n" + textRows([["Organizer", ev.organizer_name], ["Email", ev.organizer_email], ["Phone", ev.organizer_phone],
        ["Submitted", meta.submitted_at ? fmtDateTime(meta.submitted_at) : ""]]),
      "Approve or send it back from the events queue: " + linkOf(ctx.links, "owner_events", linkOf(ctx.links, "owner", ""))
    ]
  });
  return { subject: eventApprovalRequestSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: event_changes_requested  (organizer)
   ----------------------------------------------------------------------------
   The other half of the approval loop: the platform owner reviewed a pending
   event and sent it back instead of approving it. The reason is quoted verbatim
   so the organizer knows exactly what to fix before resubmitting.
   ========================================================================== */
function eventChangesRequestedSubject(p){
  const ctx = normalise(p);
  return "Changes needed before " + (ctx.event.title || "your event") + " can go live";
}
function eventChangesRequestedBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event;
  const reason = ctx.reason || "";
  const heading = "Your event was not approved yet";
  const subheading = (ev.title || "Your event") + " is still a draft. Fix what is listed below and submit it again.";
  const content =
    alertBox("warn", "Still a draft", reason ||
      "A platform administrator reviewed this event and asked for changes before it can be published.") +
    eventCard(ev) +
    sectionTitle("What to do next") +
    steps([
      "Update the event details, poster or ticket types in the organizer dashboard.",
      "Save, then set the event status to Active again to resubmit it for approval.",
      "It goes on sale the moment the platform team approves it - you are emailed either way."
    ]) +
    noteBox("<strong>Nothing is public while the event is a draft.</strong> The event page and ticket sales stay closed, " +
      "and no customer can be charged, until it is approved.") +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Open my events", url: linkOf(ctx.links, "organizer", "") },
      { label: "Contact support", url: linkOf(ctx.links, "support", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Event update",
    preheader: (ev.title || "Your event") + " needs changes before it can be published.",
    badge: { text: "Needs changes", kind: "warn" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email as the organizer of this event."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email as the organizer of this event.",
    blocks: [
      reason || "A platform administrator asked for changes before this event can be published.",
      ev.title ? ("EVENT\n" + textRows([["Title", ev.title], ["When", eventWhen(ev)], ["Where", eventWhere(ev)]])) : "",
      "Update the event, then set its status to Active to resubmit it for approval."
    ]
  });
  return { subject: eventChangesRequestedSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: organizer_status
   ----------------------------------------------------------------------------
   Sent when the platform owner suspends or reactivates an organizer account.
   ========================================================================== */
function organizerStatusSubject(p){
  const ctx = normalise(p);
  const status = (ctx.meta && ctx.meta.status) || "updated";
  return "Your " + ctx.brand.product + " organizer account is " + status;
}
function organizerStatusBody(payload){
  const ctx = normalise(payload);
  const status = String((ctx.meta && ctx.meta.status) || "updated").toLowerCase();
  const suspended = status === "suspended" || status === "rejected";
  const heading = suspended ? "Your organizer account was suspended" : "Your organizer account is active again";
  const subheading = suspended
    ? "Ticket sales from your live events are paused while the account is under review."
    : "You can sell tickets and manage events again.";
  const content =
    alertBox(suspended ? "err" : "ok", suspended ? "Account suspended" : "Account reactivated",
      ctx.reason || (suspended
        ? "An administrator suspended this account. Existing tickets stay valid for their holders, but new sales are stopped."
        : "An administrator reactivated this account. Your live events can be published again.")) +
    sectionTitle(suspended ? "What is affected" : "What to do next") +
    steps(suspended
      ? ["Live events were paused automatically - no new orders are accepted.",
         "Tickets already sold remain valid; attendee records are untouched.",
         "Reply to this email if you believe this was a mistake or want to appeal."]
      : ["Review your events and publish the ones you want on sale.",
         "Confirm your payment settings are still correct.",
         "Contact support if anything looks wrong."]) +
    '<div style="height:18px"></div>' +
    buttonRow([
      { label: "Open dashboard", url: linkOf(ctx.links, "organizer", "") },
      { label: "Contact support", url: linkOf(ctx.links, "support", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Account",
    preheader: subheading,
    badge: { text: suspended ? "Suspended" : "Active", kind: suspended ? "err" : "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because you hold an organizer account on " + ctx.brand.product + "."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because you hold an organizer account on " + ctx.brand.product + ".",
    blocks: [ctx.reason || (suspended ? "New sales are stopped and live events were paused." : "You can sell tickets again.")]
  });
  return { subject: organizerStatusSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: refund_processed
   ----------------------------------------------------------------------------
   Sent after a refund has actually been issued in the provider dashboard. The
   platform never claims a refund happened on its own, so this template is
   triggered deliberately by the owner (POST /api/owner/emails/send).
   ========================================================================== */
function refundSubject(p){
  const ctx = normalise(p);
  return "Refund issued for " + (ctx.event.title || "your order");
}
function refundBody(payload){
  const ctx = normalise(payload);
  const ev = ctx.event, order = ctx.order;
  const amount = money(ctx.meta && ctx.meta.refund_amount != null ? ctx.meta.refund_amount : order.amount, order.currency);
  const heading = "Your refund has been issued";
  const subheading = "We sent " + amount + " back through the same payment channel you used.";
  const content =
    alertBox("ok", "Refund issued", (ctx.reason || ("Order " + (order.number || "-") + " was refunded.")) +
      " Any tickets issued for this order are now void, so the QR codes will not scan at the gate.") +
    eventCard(ev) +
    sectionTitle("Refund details") +
    detailTable([
      ["Order number", order.number],
      ["Amount refunded", amount],
      ["Refund reference", (ctx.meta && ctx.meta.refund_reference) || ""],
      ["Channel", (ctx.meta && ctx.meta.channel) || order.provider_label || "original payment channel"],
      ["Issued on", fmtDateTime((ctx.meta && ctx.meta.refunded_at) || new Date().toISOString())]
    ]) +
    sectionTitle("How long it takes") +
    noteBox("Card refunds typically appear on your statement within 5 to 10 business days. Mobile money refunds are usually faster. " +
      "The exact timing is set by your bank or wallet provider, not by us.") +
    '<div style="height:16px"></div>' +
    buttonRow([
      { label: "Contact support", url: linkOf(ctx.links, "support", "") },
      { label: "Browse events", url: linkOf(ctx.links, "events", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Payment",
    preheader: amount + " was refunded for order " + (order.number || "") + ".",
    badge: { text: "Refunded", kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because a refund was issued for an order placed with this address."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because a refund was issued for an order placed with this address.",
    blocks: [
      amount + " was refunded for order " + (order.number || "-") + ".",
      "Any tickets issued for this order are now void and will not scan at the gate.",
      "REFUND\n" + textRows([["Order number", order.number], ["Amount", amount],
        ["Reference", (ctx.meta && ctx.meta.refund_reference) || ""], ["Channel", (ctx.meta && ctx.meta.channel) || ""]]),
      "TIMING\nCard refunds usually appear within 5 to 10 business days; mobile money is usually faster."
    ]
  });
  return { subject: refundSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: test_email
   ----------------------------------------------------------------------------
   Proof that BREVO_API_KEY, the sender address and the relay all work. Used by
   POST /api/owner/emails/test before a real campaign or event day.
   ========================================================================== */
function testSubject(p){
  const ctx = normalise(p);
  return ctx.brand.product + " email delivery test";
}
function testBody(payload){
  const ctx = normalise(payload);
  const heading = "Brevo is connected";
  const subheading = "If you are reading this in your inbox, transactional email is fully configured.";
  const content =
    alertBox("ok", "Test message delivered", "This is the same pipeline every order, ticket and support email uses - no separate test mode.") +
    sectionTitle("Delivery details") +
    detailTable([
      ["Sent to", ctx.customer.email],
      ["Provider", "Brevo (transactional email API)"],
      ["Requested by", (ctx.meta && ctx.meta.requested_by) || "platform owner"],
      ["Sent at", fmtDateTime(new Date().toISOString())],
      ["Templates available", String((ctx.meta && ctx.meta.template_count) || 13)]
    ]) +
    sectionTitle("What to check if it worked") +
    steps([
      "This message arrived in the inbox rather than spam - the sender domain is verified in Brevo.",
      "Links in the footer open the correct site.",
      "The brand colours and logo bar match the site.",
      "Retry a failed order in the email outbox to confirm end-user delivery."
    ]) +
    '<div style="height:18px"></div>' +
    buttonRow([{ label: "Open admin dashboard", url: linkOf(ctx.links, "owner", "") }]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Diagnostics",
    preheader: "Test email from " + ctx.brand.product + " - delivery is working.",
    badge: { text: "Test", kind: "info" },
    heading: heading, subheading: subheading, content: content,
    legal: "This is a configuration test requested from the admin area."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "This is a configuration test requested from the admin area.",
    blocks: ["Transactional email is configured and delivering.", "Sent at " + fmtDateTime(new Date().toISOString()) + "."]
  });
  return { subject: testSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE: free_ticket_otp
   ----------------------------------------------------------------------------
   The one-time code that proves an attendee owns the address claiming a FREE
   ticket. It is delivered through the ordinary Brevo pipeline and queue - no
   separate transport - but it deliberately differs from every other template:
     - the code is never rendered into a link, so a scanner that follows every
       URL still cannot consume it;
     - it carries NO ticket and NO QR image (a code is not a ticket);
     - the payload only ever holds the code at render time, never in the outbox
       (the Worker stores the queue row WITHOUT the plaintext code - see the
       worker's queueFreeOtpEmail, which renders this template immediately).
   ========================================================================== */
function otpSubject(p){
  const ctx = normalise(p);
  return "Your " + ctx.brand.product + " verification code"
    + (ctx.event.title ? " for " + ctx.event.title : "");
}
function otpBody(payload){
  const ctx = normalise(payload);
  const meta = ctx.meta || {};
  const code = String(meta.code || "").replace(/[^0-9]/g, "").slice(0, 8);
  const minutes = Number(meta.expires_minutes) || 5;
  const heading = "Confirm your email address";
  const subheading = "Enter this code on the verification screen to claim your free ticket.";
  const digits = code ? code : "\u2022\u2022\u2022\u2022\u2022\u2022";
  const codeBox = surface(
    '<div style="text-align:center">' +
      '<div style="font:400 13px/1.5 ' + EMAIL_FONT + ';color:' + COLORS.muted + ';margin:0 0 8px">Your verification code</div>' +
      '<div style="font:700 34px/1.2 ' + EMAIL_MONO + ';letter-spacing:8px;color:' + COLORS.ink + '">' + esc(digits) + "</div>" +
      '<div style="font:400 13px/1.6 ' + EMAIL_FONT + ';color:' + COLORS.muted + ';margin:12px 0 0">This code expires in ' + esc(String(minutes)) + " minutes.</div>" +
      '<div style="font:400 12px/1.6 ' + EMAIL_FONT + ';color:' + COLORS.faint + ';margin:4px 0 0">Enter it exactly as shown. Codes are single use.</div>' +
    "</div>", "22px");
  const content =
    codeBox +
    alertBox("warn", "Never share this code",
      "TicketHub and the event organizer will never ask you for it. Anyone with this code can claim the free ticket.") +
    (ctx.event.title ? sectionTitle("Event") + eventCard(ctx.event, { note: meta.quantity ? String(meta.quantity) + " free ticket(s) requested." : "" }) : "") +
    '<div style="height:10px"></div>' +
    noteBox("If you did not request a free ticket, you can safely ignore this email. No ticket was created and nothing was registered - the code will simply expire.");
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Verification",
    preheader: "Your verification code expires in " + minutes + " minutes.",
    badge: { text: "Email verification", kind: "info" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this because a free ticket was requested with this email address on " + ctx.brand.product + "."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this because a free ticket was requested with this email address on " + ctx.brand.product + ".",
    blocks: [
      "Your verification code is: " + code,
      "It expires in " + minutes + " minutes and can only be used once.",
      "Never share this code - TicketHub and the organizer will never ask you for it.",
      "If you did not request it, ignore this email. No ticket was created and the code will expire."
    ]
  });
  return { subject: otpSubject(payload), html: html, text: text };
}


/* ============================================================================
   TEMPLATES: THE ORGANIZER AGREEMENT SUITE (migration 0008)
   ----------------------------------------------------------------------------
   Four transactional emails drive the mandatory Digital Organizer Agreement
   workflow:

     organizer_agreement_invitation  the single-use, time-limited signing link
     organizer_agreement_signed      the completed-signature confirmation
     organizer_agreement_updated     a new agreement version needs re-acceptance
     organizer_agreement_reminder    a gentle chase for an unsigned agreement

   Rules obeyed here:
     - The raw signing TOKEN is never printed on its own: it only ever appears as
       part of the full review URL, which is what the organizer must click.
     - Fees are shown in full, never collapsed: an organizer must be able to read
       the commercial terms before they sign.
   ========================================================================== */
/* One shared, readable rendering of the fee configuration, built from the
   SNAPSHOT the organizer accepted - so a later agreement version can never
   change what an old confirmation email says. */
function agreementFeeRows(fee){
  const f = fee || {};
  const rows = [];
  if(f.commission_percent != null && f.commission_percent !== "") rows.push(["Platform commission", String(f.commission_percent) + "% of the ticket subtotal"]);
  if(f.commission_fixed != null && Number(f.commission_fixed) > 0) rows.push(["Fixed platform fee", money(f.commission_fixed) + " per order"]);
  if(f.commission_basis) rows.push(["Commission basis", String(f.commission_basis)]);
  if(f.payment_fees) rows.push(["Payment processing fees", String(f.payment_fees)]);
  if(f.payout_terms) rows.push(["Payout terms", String(f.payout_terms)]);
  if(f.refund_policy) rows.push(["Refunds", String(f.refund_policy)]);
  if(f.cancellation_policy) rows.push(["Cancellation", String(f.cancellation_policy)]);
  if(f.chargeback_policy) rows.push(["Chargebacks and disputes", String(f.chargeback_policy)]);
  if(f.termination_conditions) rows.push(["Termination", String(f.termination_conditions)]);
  return rows;
}
function agreementFeeTable(fee){
  const rows = agreementFeeRows(fee);
  if(!rows.length) return "";
  return sectionTitle("Your platform fee terms") + detailTable(rows);
}
function agreementFeeText(fee){
  const rows = agreementFeeRows(fee);
  if(!rows.length) return "";
  return "PLATFORM FEE TERMS\n" + textRows(rows);
}

/* ---------------------- A. organizer_agreement_invitation ----------------- */
function agreementInvitationSubject(p){
  const a = (p && p.agreement) || {};
  return "Action Required: Review and Sign Your " + ((p && p.brand && p.brand.product) || "TicketHub") +
    " Organizer Agreement" + (a.version ? " (v" + a.version + ")" : "");
}
function agreementInvitationBody(payload){
  const ctx = normalise(payload);
  const a = (payload && payload.agreement) || {};
  const who = firstName(ctx.customer.name) || "there";
  const reviewUrl = linkOf(ctx.links, "agreement_review", "");
  const heading = "Please review and sign your organizer agreement";
  const subheading = "One signature is all that stands between you and publishing your next event.";
  const content =
    alertBox("warn", "Signing is required before you can publish",
      "Events cannot go on sale until this agreement is signed and accepted. You can still build drafts, set up ticket types " +
      "and get your payment details ready while you review it.") +
    detailTable([
      ["Agreement", a.title || "TicketHub Organizer Agreement"],
      ["Version", a.version || "-"],
      ["Effective date", a.effective_date ? fmtDate(a.effective_date) : "On acceptance"],
      ["Link expires", a.expires_at ? fmtDateTime(a.expires_at) : "24 hours from now"]
    ]) +
    agreementFeeTable(a.fee_config) +
    sectionTitle("Why you are receiving this") +
    noteBox("Every organizer must accept the current organizer agreement before we can publish their events. The agreement sets out the " +
      "platform fees, payout terms, refund and chargeback responsibilities and what each side is responsible for. Nothing changes for your " +
      "existing confirmed bookings: their fee arrangements stay exactly as they were.") +
    buttonRow([{ label: "Review and sign the agreement", url: reviewUrl }]) +
    alertBox("neutral", "Security note", "This link is personal to your account, works once and expires. We will never ask you to send your " +
      "password, and you should not forward this link to anyone.");
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Agreement",
    preheader: "Review and sign the " + (a.title || "Organizer Agreement") + (a.version ? " (v" + a.version + ")" : "") + ".",
    badge: { text: "Action required", kind: "warn" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because you manage an organizer account on " + ctx.brand.product + "."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because you manage an organizer account on " + ctx.brand.product + ".",
    blocks: [
      "Hello " + who + ",",
      "Please review and sign the " + (a.title || "TicketHub Organizer Agreement") + (a.version ? " (version " + a.version + ")" : "") +
        ". Events cannot be published on " + ctx.brand.product + " until this agreement is signed.",
      textRows([["Version", a.version || "-"], ["Effective date", a.effective_date ? fmtDate(a.effective_date) : "On acceptance"],
        ["Link expires", a.expires_at ? fmtDateTime(a.expires_at) : "24 hours from now"]]),
      agreementFeeText(a.fee_config),
      "Review and sign: " + reviewUrl,
      "This link is personal to your account, works once and expires. If it has expired, open your dashboard and request a new one."
    ]
  });
  return { subject: agreementInvitationSubject(payload), html: html, text: text };
}

/* ------------------------ B. organizer_agreement_signed ------------------- */
function agreementSignedSubject(p){
  const a = (p && p.agreement) || {};
  return "Your " + ((p && p.brand && p.brand.product) || "TicketHub") + " Organizer Agreement Has Been Signed" +
    (a.version ? " (v" + a.version + ")" : "");
}
function agreementSignedBody(payload){
  const ctx = normalise(payload);
  const a = (payload && payload.agreement) || {};
  const heading = "Your organizer agreement is signed";
  const subheading = "A copy is stored against your account and is available from your dashboard at any time.";
  const content =
    alertBox("ok", "You can publish events now",
      "Your account is up to date with the current organizer agreement. Events you submit for publishing will go through the " +
      "normal platform review without an agreement hold.") +
    detailTable([
      ["Agreement", a.title || "TicketHub Organizer Agreement"],
      ["Version", a.version || "-"],
      ["Signed by", a.signatory_name || ctx.customer.name || "-"],
      ["Signed on (UTC)", a.signed_at ? fmtDateTime(a.signed_at) : ""],
      ["Agreement reference", a.reference || "-"],
      ["Accepted from", a.signatory_email || ctx.customer.email || "-"]
    ]) +
    agreementFeeTable(a.fee_config) +
    sectionTitle("Your copy") +
    noteBox("You can print or download the signed agreement from your dashboard whenever you need it. The stored copy is the exact text " +
      "and fee terms that applied when you signed, with the signing time recorded in UTC.") +
    buttonRow([
      { label: "View or download the agreement", url: linkOf(ctx.links, "agreement", "") },
      { label: "Back to dashboard", url: linkOf(ctx.links, "organizer", ""), kind: "ghost" }
    ]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Agreement",
    preheader: "Your organizer agreement (v" + (a.version || "-") + ") is signed - reference " + (a.reference || "-") + ".",
    badge: { text: "Signed", kind: "ok" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because this agreement was accepted by your organizer account. Keep it for your records."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because this agreement was accepted by your organizer account. Keep it for your records.",
    blocks: [
      "Your organizer agreement has been signed and stored.",
      textRows([["Agreement", a.title || "TicketHub Organizer Agreement"], ["Version", a.version || "-"],
        ["Signed by", a.signatory_name || ""], ["Agreement reference", a.reference || "-"]]),
      agreementFeeText(a.fee_config),
      "Your copy is available from your dashboard: " + linkOf(ctx.links, "agreement", "")
    ]
  });
  return { subject: agreementSignedSubject(payload), html: html, text: text };
}

/* ----------------------- C. organizer_agreement_updated ------------------- */
function agreementUpdatedSubject(p){
  const a = (p && p.agreement) || {};
  return "Important: " + ((p && p.brand && p.brand.product) || "TicketHub") + " Organizer Agreement Updated" +
    (a.version ? " (v" + a.version + ")" : "");
}
function agreementUpdatedBody(payload){
  const ctx = normalise(payload);
  const a = (payload && payload.agreement) || {};
  const heading = "Our organizer agreement has been updated";
  const subheading = "Please review version " + (a.version || "of the agreement") + " and accept it to keep publishing events.";
  const content =
    alertBox("warn", "Re-acceptance required before your next publication",
      "Your earlier agreement stays valid for the events already published under it. This new version applies to events you publish " +
      "from now on, so it must be accepted before the next one can go live.") +
    detailTable([
      ["Agreement", a.title || "TicketHub Organizer Agreement"],
      ["New version", a.version || "-"],
      ["Previous version", a.previous_version || "-"],
      ["Effective date", a.effective_date ? fmtDate(a.effective_date) : "On acceptance"],
      ["Link expires", a.expires_at ? fmtDateTime(a.expires_at) : "24 hours from now"]
    ]) +
    (a.summary ? sectionTitle("What changed") + noteBox(esc(a.summary)) : "") +
    agreementFeeTable(a.fee_config) +
    sectionTitle("What stays the same") +
    noteBox("Confirmed bookings and completed transactions keep the fee arrangements that applied when they were made. Refunds, payouts and " +
      "settlements already agreed are not recalculated by this update.") +
    buttonRow([{ label: "Review and accept the new version", url: linkOf(ctx.links, "agreement_review", "") }]);
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Agreement",
    preheader: "Version " + (a.version || "-") + " of the organizer agreement needs your review.",
    badge: { text: "Review needed", kind: "warn" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this email because you manage an organizer account on " + ctx.brand.product + "."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this email because you manage an organizer account on " + ctx.brand.product + ".",
    blocks: [
      "Our organizer agreement has been updated to version " + (a.version || "-") + ".",
      a.summary ? ("What changed: " + a.summary) : "",
      textRows([["New version", a.version || "-"], ["Previous version", a.previous_version || "-"],
        ["Effective date", a.effective_date ? fmtDate(a.effective_date) : "On acceptance"]]),
      agreementFeeText(a.fee_config),
      "Events already published keep the terms they were published under. The new version applies to what you publish from now on.",
      "Review and accept: " + linkOf(ctx.links, "agreement_review", "")
    ]
  });
  return { subject: agreementUpdatedSubject(payload), html: html, text: text };
}

/* ----------------------- D. organizer_agreement_reminder ------------------ */
function agreementReminderSubject(p){
  const a = (p && p.agreement) || {};
  return "Reminder: your " + ((p && p.brand && p.brand.product) || "TicketHub") + " Organizer Agreement is still unsigned" +
    (a.version ? " (v" + a.version + ")" : "");
}
function agreementReminderBody(payload){
  const ctx = normalise(payload);
  const a = (payload && payload.agreement) || {};
  const heading = "Your organizer agreement is still unsigned";
  const subheading = "Publishing stays paused until it is signed. This is the only reminder we will send for this version.";
  const content =
    alertBox("warn", "Publishing is paused",
      "Your events stay in draft and cannot be submitted for publishing until version " + (a.version || "of the agreement") +
      " is signed and accepted.") +
    detailTable([["Agreement", a.title || "TicketHub Organizer Agreement"], ["Version", a.version || "-"],
      ["Link expires", a.expires_at ? fmtDateTime(a.expires_at) : "24 hours from now"]]) +
    agreementFeeTable(a.fee_config) +
    buttonRow([{ label: "Review and sign the agreement", url: linkOf(ctx.links, "agreement_review", "") }]) +
    noteBox("If you would rather not accept these terms, no action is needed: your drafts stay in your account and nothing is charged.");
  const html = emailShell({
    brand: ctx.brand, links: ctx.links, chip: "Agreement",
    preheader: "One reminder: your organizer agreement is still unsigned.",
    badge: { text: "Reminder", kind: "warn" },
    heading: heading, subheading: subheading, content: content,
    legal: "You received this reminder because you manage an organizer account on " + ctx.brand.product + "."
  });
  const text = plainText({
    brand: ctx.brand, links: ctx.links, heading: heading,
    legal: "You received this reminder because you manage an organizer account on " + ctx.brand.product + ".",
    blocks: [
      "Your organizer agreement (version " + (a.version || "-") + ") is still unsigned, so events cannot be published.",
      agreementFeeText(a.fee_config),
      "Review and sign: " + linkOf(ctx.links, "agreement_review", "")
    ]
  });
  return { subject: agreementReminderSubject(payload), html: html, text: text };
}

/* ============================================================================
   TEMPLATE REGISTRY
   ----------------------------------------------------------------------------
   The single source of truth: templateList() feeds GET /api/owner/emails and
   the preview harness, renderEmail() is what the outbox sends.
   ========================================================================== */
const REGISTRY = [
  { key: "ticket_ready", name: "Tickets delivered", category: "transactional", chip: "Your tickets",
    description: "Confirmation, receipt and QR tickets. Sent when a payment is verified or a free order is settled.",
    subject: ticketSubject, run: p => ticketBody(p, "ready") },
  { key: "ticket_resend", name: "Tickets resent", category: "transactional", chip: "Your tickets",
    description: "A copy of the existing tickets, sent when a buyer asks for them again.",
    subject: resendSubject, run: p => ticketBody(p, "resend") },
  { key: "order_pending", name: "Order awaiting payment", category: "transactional", chip: "Order",
    description: "Sent when an order is created but the payment is not confirmed yet.",
    subject: orderPendingSubject, run: orderPendingBody },
  { key: "free_ticket_otp", name: "Free ticket verification code", category: "transactional", chip: "Verification",
    description: "The one-time code that proves an attendee owns the address claiming a free ticket. Never contains a QR code.",
    subject: otpSubject, run: otpBody },
  { key: "payment_failed", name: "Payment failed", category: "transactional", chip: "Payment",
    description: "Sent when the provider reports a failed or abandoned payment.",
    subject: paymentFailedSubject, run: paymentFailedBody },
  { key: "welcome", name: "Organizer welcome", category: "transactional", chip: "Welcome",
    description: "Onboarding checklist sent when an organizer finishes registration.",
    subject: welcomeSubject, run: welcomeBody },
  { key: "new_sale", name: "New sale (organizer)", category: "transactional", chip: "Sale",
    description: "Sent to the organizer when a payment settles, with buyer contact details.",
    subject: newSaleSubject, run: newSaleBody },
  { key: "contact_message", name: "Contact form message", category: "internal", chip: "Support",
    description: "Sent to the platform support address for every contact form submission.",
    subject: contactMessageSubject, run: contactMessageBody },
  { key: "contact_ack", name: "Contact form acknowledgement", category: "transactional", chip: "Support",
    description: "Auto-reply confirming that a contact form message was received.",
    subject: contactAckSubject, run: contactAckBody },
  { key: "event_cancelled", name: "Event cancelled", category: "transactional", chip: "Event update",
    description: "Sent to every paid attendee and the organizer when an event is cancelled.",
    subject: eventCancelledSubject, run: eventCancelledBody },
  { key: "event_published", name: "Event published", category: "transactional", chip: "Event update",
    description: "Sent to the organizer when an event goes live (including owner approval).",
    subject: eventPublishedSubject, run: eventPublishedBody },
  { key: "event_pending_approval", name: "Event awaiting approval (owner)", category: "internal", chip: "Event update",
    description: "Sent to every active platform owner when an organizer submits an event for publishing.",
    subject: eventApprovalRequestSubject, run: eventApprovalRequestBody },
  { key: "event_changes_requested", name: "Event sent back for changes", category: "transactional", chip: "Event update",
    description: "Sent to the organizer when an owner sends a submitted event back instead of approving it.",
    subject: eventChangesRequestedSubject, run: eventChangesRequestedBody },
  { key: "organizer_status", name: "Organizer account status", category: "transactional", chip: "Account",
    description: "Sent when an owner suspends or reactivates an organizer account.",
    subject: organizerStatusSubject, run: organizerStatusBody },
  { key: "refund_processed", name: "Refund issued", category: "transactional", chip: "Payment",
    description: "Sent after a refund is issued in the provider dashboard (owner triggered).",
    subject: refundSubject, run: refundBody },
  { key: "test_email", name: "Delivery test", category: "internal", chip: "Diagnostics",
    description: "Verifies BREVO_API_KEY, the sender address and the relay end to end.",
    subject: testSubject, run: testBody },
  /* --- the mandatory organizer agreement suite (migration 0008) ------------ */
  { key: "organizer_agreement_invitation", name: "Organizer agreement invitation", category: "transactional", chip: "Agreement",
    description: "The single-use, time-limited link that invites an organizer to review and sign the active agreement.",
    subject: agreementInvitationSubject, run: agreementInvitationBody },
  { key: "organizer_agreement_signed", name: "Organizer agreement signed", category: "transactional", chip: "Agreement",
    description: "Confirmation of a completed signature, with the agreement reference and the accepted fee summary.",
    subject: agreementSignedSubject, run: agreementSignedBody },
  { key: "organizer_agreement_updated", name: "Organizer agreement updated", category: "transactional", chip: "Agreement",
    description: "Tells organizers that a new agreement version needs review and acceptance before their next publication.",
    subject: agreementUpdatedSubject, run: agreementUpdatedBody },
  { key: "organizer_agreement_reminder", name: "Organizer agreement reminder", category: "transactional", chip: "Agreement",
    description: "A single, proportionate reminder for an agreement that is still unsigned.",
    subject: agreementReminderSubject, run: agreementReminderBody }
];
export const TEMPLATES = {};
for(const t of REGISTRY) TEMPLATES[t.key] = t;
export function isTemplate(key){
  return Object.prototype.hasOwnProperty.call(TEMPLATES, String(key || ""));
}
export function templateCategory(key){
  const t = TEMPLATES[key];
  return t ? t.category : "";
}
export function templateList(){
  return REGISTRY.map(t => ({ key: t.key, name: t.name, description: t.description, category: t.category }));
}
export function renderEmail(key, payload){
  const t = TEMPLATES[key];
  if(!t) throw new Error("Unknown email template: " + key);
  const out = t.run(payload || {}) || {};
  return {
    template: key,
    subject: safeSubject(out.subject, t.name),
    html: String(out.html || ""),
    text: String(out.text || ""),
    category: t.category
  };
}
/* Subject only: queueing an email must not build the whole document, because
   the HTML is rendered again at delivery time (so template fixes apply to mail
   that is still queued). */
export function renderSubject(key, payload){
  const t = TEMPLATES[key];
  if(!t) throw new Error("Unknown email template: " + key);
  let subject = "";
  try { subject = t.subject(payload || {}); } catch(e){ subject = t.name; }
  return safeSubject(subject, t.name);
}

/* ============================================================================
   BREVO TRANSPORT
   ----------------------------------------------------------------------------
   POST https://api.brevo.com/v3/smtp/email with the BREVO_API_KEY secret.
   Failures are classified: a 5xx/429/network error is retryable, anything else
   is permanent (bad key, unverified sender, blocked recipient) and is recorded
   as such instead of being retried forever.
   ========================================================================== */
export const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
export const MAX_ATTEMPTS = 5;
export const MAX_SEND_PER_DISPATCH = 25;
const BREVO_TIMEOUT_MS = 15000;
const SETTINGS_CACHE_MS = 60000;
const SETTING_KEYS = ["platform_name", "brand_line", "support_email", "support_phone", "public_base_url",
  "email_from_name", "email_from_email", "email_reply_to", "email_enabled"];

async function dbAll(env, sql, params){ const r = await env.DB.prepare(sql).bind(...(params || [])).all(); return (r && r.results) || []; }
async function dbGet(env, sql, params){ const rows = await dbAll(env, sql, params); return rows[0] || null; }
async function dbRun(env, sql, params){ return env.DB.prepare(sql).bind(...(params || [])).run(); }
function nowIso(){ return new Date().toISOString().replace("T", " ").slice(0, 19); }
function parsePayload(row){
  try { return JSON.parse((row && row.payload_json) || "{}") || {}; } catch(e){ return {}; }
}
function withMeta(payload, meta){
  return Object.assign({}, payload || {}, { _email: meta });
}
function stored(payload){
  const raw = JSON.stringify(payload);
  return raw.length > 200000 ? raw.slice(0, 200000) : raw;
}
export function isEmailConfigured(env){
  return !!String((env && env.BREVO_API_KEY) || "").trim();
}
/* app_settings is read through a short-lived cache: a ticket email must not
   make every ledger write wait on extra SELECTs. */
let settingsCache = { at: 0, values: null };
export async function loadEmailSettings(env, force){
  const now = Date.now();
  if(!force && settingsCache.values && (now - settingsCache.at) < SETTINGS_CACHE_MS) return settingsCache.values;
  const values = {};
  try {
    const rows = await dbAll(env, "SELECT key, value FROM app_settings", []);
    for(const r of rows) if(SETTING_KEYS.indexOf(r.key) >= 0) values[r.key] = r.value;
  } catch(e){ /* a missing table/row is not fatal: defaults apply */ }
  settingsCache = { at: now, values: values };
  return values;
}
export function resetEmailSettingsCache(){
  settingsCache = { at: 0, values: null };
}
export function resolveSender(env, settings){
  const s = settings || {};
  const fromEmail = validEmail(s.email_from_email || (env && env.EMAIL_FROM) || (env && env.BREVO_SENDER_EMAIL) || (env && env.SUPPORT_EMAIL)) ||
    validEmail(BRAND.support_email);
  const fromName = String(s.email_from_name || (env && env.EMAIL_FROM_NAME) || s.platform_name || BRAND.product).slice(0, 120);
  const replyTo = validEmail(s.email_reply_to || (env && env.EMAIL_REPLY_TO)) || validEmail(s.support_email) || fromEmail || null;
  return { email: fromEmail, name: fromName, reply_to: replyTo };
}
export function emailSendingEnabled(env, settings){
  const s = settings || {};
  const flag = String(s.email_enabled == null ? "true" : s.email_enabled).toLowerCase();
  if(flag === "false" || flag === "0" || flag === "off") return false;
  if(String((env && env.EMAIL_DISABLED) || "").toLowerCase() === "true") return false;
  return true;
}
export function emailStatus(env, settings){
  const sender = resolveSender(env, settings);
  return {
    provider: "brevo",
    configured: isEmailConfigured(env),
    enabled: emailSendingEnabled(env, settings),
    sender: sender.email || null,
    sender_name: sender.name,
    reply_to: sender.reply_to || null,
    templates: REGISTRY.length
  };
}
export async function sendViaBrevo(env, message){
  const msg = message || {};
  const key = String((env && env.BREVO_API_KEY) || "").trim();
  if(!key) return { ok: false, skipped: true, retryable: true, error: "BREVO_API_KEY is not configured on the Worker" };
  const to = validEmail(msg.to);
  if(!to) return { ok: false, skipped: true, retryable: false, error: "Recipient email address is not valid" };
  const settings = msg.settings || await loadEmailSettings(env);
  if(!emailSendingEnabled(env, settings)){
    return { ok: false, skipped: true, retryable: true, error: "Email sending is switched off in the platform settings" };
  }
  const sender = resolveSender(env, settings);
  if(!sender.email){
    return { ok: false, skipped: true, retryable: true, error: "No sender address configured: set EMAIL_FROM or app_settings.email_from_email" };
  }
  const recipient = { email: to };
  if(msg.to_name) recipient.name = String(msg.to_name).slice(0, 120);
  const body = {
    sender: { email: sender.email, name: sender.name },
    to: [recipient],
    subject: safeSubject(msg.subject, BRAND.product),
    htmlContent: msg.html || "<html><body><p>&nbsp;</p></body></html>",
    textContent: msg.text || "",
    tags: [String(msg.template || "transactional").replace(/[^a-z0-9_-]/gi, "-").slice(0, 64)],
    headers: { "X-Mailer": "PrinceAlexTicketHub", "X-TicketHub-Template": String(msg.template || "custom").slice(0, 64) }
  };
  if(sender.reply_to) body.replyTo = { email: sender.reply_to, name: sender.name };
  const attachments = collectAttachments(msg.attachments);
  if(attachments.length) body.attachment = attachments;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);
  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: { "api-key": key, "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch(e){ data = null; }
    if(res.ok){
      const messageId = (data && (data.messageId || (Array.isArray(data.messageIds) ? data.messageIds[0] : null))) || null;
      return { ok: true, status: res.status, message_id: messageId, sender: sender.email, reply_to: sender.reply_to };
    }
    const detail = (data && (data.message || data.error || data.code)) || raw.slice(0, 300) || ("HTTP " + res.status);
    return {
      ok: false, status: res.status,
      retryable: res.status >= 500 || res.status === 429,
      error: "Brevo rejected the message (HTTP " + res.status + "): " + String(detail).slice(0, 300)
    };
  } catch(e){
    return { ok: false, retryable: true, error: "Brevo request failed: " + String((e && e.message) || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
function collectAttachments(list){
  const out = [];
  for(const a of (Array.isArray(list) ? list : [])){
    if(a && a.name && a.content) out.push({ name: String(a.name).slice(0, 120), content: String(a.content) });
    if(out.length >= 10) return out;
  }
  return out;
}
/* QR PNGs travel as real attachments (so a ticket works offline) and stay in
   the email body as remote images too. Both are capped at 10 attachments. */
export function attachmentsForPayload(payload){
  const out = collectAttachments((payload && payload.attachments) || []);
  for(const t of ((payload && payload.tickets) || [])){
    if(out.length >= 10) break;
    if(t && t.qr_base64 && t.number) out.push({ name: "ticket-" + t.number + ".png", content: String(t.qr_base64) });
  }
  return out;
}

/* ============================================================================
   OUTBOX (D1 queue)
   ----------------------------------------------------------------------------
   email_outbox is the queue: a row stays 'queued' until Brevo accepts the
   message ('sent') or the failure is permanent ('failed'). No new columns are
   required - everything the queue needs beyond the original five columns lives
   inside payload_json._email, and the (template, to_email, status) index keeps
   the idempotency lookup cheap.
   ========================================================================== */
export function outboxRowView(row){
  const payload = parsePayload(row);
  const meta = payload._email || {};
  const order = payload.order || {};
  return {
    id: row.id,
    to: row.to_email,
    to_name: meta.to_name || "",
    subject: row.subject,
    template: row.template,
    status: row.status,
    category: meta.category || templateCategory(row.template),
    attempts: Number(meta.attempts || 0),
    error: row.error || null,
    provider_message_id: meta.provider_message_id || null,
    order_number: order.number || order.order_number || null,
    event_title: (payload.event && payload.event.title) || null,
    created_at: row.created_at,
    sent_at: row.sent_at
  };
}
export async function outboxStats(env){
  const out = { queued: 0, sent: 0, failed: 0, total: 0 };
  const rows = await dbAll(env, "SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status", []);
  for(const r of rows){
    const key = String(r.status || "unknown");
    out[key] = (out[key] || 0) + Number(r.n);
    out.total += Number(r.n);
  }
  return out;
}
/* Idempotency: a replayed webhook (or a double click) must not send the same
   ticket email twice. The key is compared inside payload_json._email. */
async function findQueuedOrSent(env, template, to, key){
  const rows = await dbAll(env,
    "SELECT id, payload_json, status FROM email_outbox WHERE template = ? AND to_email = ? AND status IN ('queued','sent') ORDER BY id DESC LIMIT 10",
    [template, to]);
  for(const r of rows){
    const meta = (parsePayload(r)._email) || {};
    if(meta.dedupe_key && String(meta.dedupe_key) === String(key)) return r;
  }
  return null;
}
/* queueEmail NEVER throws into a payment path: a mail problem must not fail an
   order that is already paid. The caller gets a small result object instead. */
export async function queueEmail(env, opts){
  const o = opts || {};
  if(!env || !env.DB) return { queued: false, skipped: "no_database" };
  const template = String(o.template || "");
  if(!isTemplate(template)) return { queued: false, skipped: "unknown_template" };
  const to = validEmail(o.to);
  if(!to) return { queued: false, skipped: "invalid_recipient" };
  try {
    const settings = o.settings || await loadEmailSettings(env);
    const payload = Object.assign({}, o.payload || {});
    if(!payload.brand) payload.brand = brandOf(settings);
    const dedupeKey = o.dedupe_key ? String(o.dedupe_key).slice(0, 120) : "";
    if(dedupeKey){
      const existing = await findQueuedOrSent(env, template, to, dedupeKey);
      if(existing) return { queued: false, duplicate: true, id: existing.id, to: to, template: template };
    }
    const subject = o.subject ? safeSubject(o.subject, "") : renderSubject(template, payload);
    const meta = {
      to_name: o.to_name || "",
      dedupe_key: dedupeKey,
      category: o.category || templateCategory(template),
      attempts: 0,
      queued_at: nowIso()
    };
    const res = await dbRun(env,
      "INSERT INTO email_outbox (to_email, subject, template, payload_json, status) VALUES (?,?,?,?,'queued')",
      [to, subject, template, stored(withMeta(payload, meta))]);
    return {
      queued: true,
      id: (res && res.meta ? res.meta.last_row_id : null),
      to: to, subject: subject, template: template
    };
  } catch(e){
    return { queued: false, skipped: "queue_failed", error: String((e && e.message) || e).slice(0, 240) };
  }
}
/* Queues and then tries to deliver in the background. Pass the Worker's
   ExecutionContext (ctx) so the response is never held up by Brevo. */
export function dispatchSoon(env, task, limit){
  if(!isEmailConfigured(env)) return Promise.resolve({ configured: false, sent: 0 });
  const run = dispatchOutbox(env, limit || 5).catch(e => ({ error: String((e && e.message) || e) }));
  if(task && typeof task.waitUntil === "function"){ task.waitUntil(run); return Promise.resolve({ scheduled: true }); }
  return run;
}
export async function queueAndDispatch(env, opts, task){
  const queued = await queueEmail(env, opts);
  if(queued.queued) await dispatchSoon(env, task, 6);
  return queued;
}
/* Delivers queued rows. Called by the cron trigger, by the owner admin route,
   and right after a transactional queue() call. */
export async function dispatchOutbox(env, limit, opts){
  const o = opts || {};
  const settings = await loadEmailSettings(env, true);
  const capped = Math.min(MAX_SEND_PER_DISPATCH, Math.max(1, Number(limit) || 10));
  const summary = {
    configured: isEmailConfigured(env),
    enabled: emailSendingEnabled(env, settings),
    sender: resolveSender(env, settings).email || null,
    processed: 0, sent: 0, failed: 0, retried: 0, skipped: 0, results: []
  };
  if(!summary.configured) return summary;
  const rows = await dbAll(env, "SELECT * FROM email_outbox WHERE status = 'queued' ORDER BY id ASC LIMIT ?", [capped]);
  for(const row of rows){
    summary.processed++;
    const outcome = await deliverOutboxRow(env, row, settings, o.force === true);
    if(outcome === "sent") summary.sent++;
    else if(outcome === "failed") summary.failed++;
    else if(outcome === "skipped") summary.skipped++;
    else summary.retried++;
    if(summary.results.length < 25) summary.results.push({ id: row.id, template: row.template, result: outcome });
  }
  return summary;
}
async function markOutbox(env, id, payload, meta, status, error){
  return dbRun(env,
    "UPDATE email_outbox SET status = ?, error = ?, payload_json = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ?",
    [status, error ? String(error).slice(0, 500) : null, stored(withMeta(payload, meta)), status, nowIso(), id]);
}
async function deliverOutboxRow(env, row, settings, force){
  const payload = parsePayload(row);
  const meta = Object.assign({ attempts: 0 }, payload._email || {});
  const attempts = Number(meta.attempts) || 0;
  if(!isTemplate(row.template)){
    meta.attempts = attempts;
    await markOutbox(env, row.id, payload, meta, "failed", "Unknown template: " + row.template);
    return "failed";
  }
  if(!force && attempts >= MAX_ATTEMPTS){
    meta.attempts = attempts;
    await markOutbox(env, row.id, payload, meta, "failed", "Gave up after " + attempts + " attempts");
    return "failed";
  }
  let rendered = null;
  try {
    rendered = renderEmail(row.template, payload);
  } catch(e){
    meta.attempts = attempts + 1;
    await markOutbox(env, row.id, payload, meta, "failed", "Render error: " + String((e && e.message) || e).slice(0, 240));
    return "failed";
  }
  const result = await sendViaBrevo(env, {
    to: row.to_email,
    to_name: meta.to_name,
    subject: row.subject || rendered.subject,
    html: rendered.html,
    text: rendered.text,
    template: row.template,
    attachments: attachmentsForPayload(payload),
    settings: settings
  });
  meta.attempts = attempts + 1;
  if(result.ok){
    meta.provider_message_id = result.message_id || null;
    meta.sender = result.sender || null;
    meta.delivered_at = nowIso();
    await markOutbox(env, row.id, payload, meta, "sent", null);
    return "sent";
  }
  meta.last_error = result.error || "unknown error";
  if(result.skipped){
    /* Misconfiguration (no key/sender, sending switched off): stays queued so
       nothing is lost, and the outbox explains what to fix. */
    await markOutbox(env, row.id, payload, meta, "queued", result.error);
    return "skipped";
  }
  if(result.retryable && meta.attempts < MAX_ATTEMPTS){
    await markOutbox(env, row.id, payload, meta, "queued", result.error);
    return "retried";
  }
  /* Retries exhausted: keep the provider error but say so, otherwise an
     operator cannot tell "failed once" from "we stopped trying". */
  const finalError = (result.retryable && meta.attempts >= MAX_ATTEMPTS)
    ? "Gave up after " + meta.attempts + " attempts - last error: " + result.error
    : result.error;
  await markOutbox(env, row.id, payload, meta, "failed", finalError);
  return "failed";
}
/* Puts a failed (or already sent) message back in the queue. */
export async function requeueEmail(env, id){
  const row = await dbGet(env, "SELECT * FROM email_outbox WHERE id = ?", [id]);
  if(!row) return null;
  /* Folding the legacy .html links on the way back in means a row queued before
     the folder move is repaired in D1, not just at render time - the resend
     that follows therefore carries the current /ticket/ shape. */
  const payload = normalisePayloadLinks(parsePayload(row));
  const meta = Object.assign({ attempts: 0 }, payload._email || {});
  meta.attempts = 0;
  meta.requeued_at = nowIso();
  delete meta.last_error;
  await dbRun(env, "UPDATE email_outbox SET status = 'queued', error = NULL, sent_at = NULL, payload_json = ? WHERE id = ?",
    [stored(withMeta(payload, meta)), row.id]);
  return outboxRowView(Object.assign({}, row, { status: "queued", error: null, sent_at: null }));
}
/* Ad-hoc send (owner only): one template, one recipient, delivered straight
   away - refund notices, announcements, follow-ups. Nothing is stored in the
   outbox unless the caller used queueEmail() instead. */
export async function sendTemplateNow(env, opts){
  const o = opts || {};
  if(!isTemplate(o.template)) return { ok: false, error: "Unknown template: " + o.template };
  const to = validEmail(o.to);
  if(!to) return { ok: false, error: "A valid recipient email address is required" };
  const settings = await loadEmailSettings(env, true);
  const payload = Object.assign({}, o.payload || {});
  if(!payload.brand) payload.brand = brandOf(settings);
  if(!payload.customer) payload.customer = { name: o.to_name || "", email: to };
  const rendered = renderEmail(o.template, payload);
  const result = await sendViaBrevo(env, {
    to: to,
    to_name: o.to_name,
    subject: o.subject || rendered.subject,
    html: rendered.html,
    text: rendered.text,
    template: o.template,
    attachments: attachmentsForPayload(payload),
    settings: settings
  });
  return Object.assign({ template: o.template, to: to, subject: rendered.subject }, result);
}
/* Configuration test: proves the key, the sender address and the relay in one
   request (POST /api/owner/emails/test). */
export async function sendTestEmail(env, opts){
  const o = opts || {};
  const to = validEmail(o.to);
  if(!to) return { ok: false, error: "A valid recipient email address is required" };
  const links = o.links || {};
  return sendTemplateNow(env, {
    template: "test_email",
    to: to,
    to_name: o.to_name,
    links: links,
    payload: {
      links: links,
      customer: { name: o.to_name || "", email: to },
      meta: { requested_by: o.requested_by || "platform owner", template_count: REGISTRY.length, sent_at: nowIso() }
    }
  });
}
