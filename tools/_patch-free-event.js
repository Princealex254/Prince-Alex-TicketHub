/* Reads a numeric field, or null when it is blank. Blank means "use the platform
   default", so the key is left out of the payload entirely. */
function intOrNull(id){
  const el = $("#" + id);
  if(!el) return null;
  const raw = String(el.value == null ? "" : el.value).trim();
  if(!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}
/* Only the four documented threshold keys are ever sent, each one only when the
   organizer typed a value - and an empty object when none is set, which tells the
   Worker to clear an earlier override. The Worker clamps every number again. */
function freeConfigPayload(){
  const out = {};
  ["free_otp_ip_limit","free_otp_ip_window","free_register_ip_limit","free_register_ip_window"].forEach(function(id){
    const n = intOrNull(id);
    if(n !== null) out[id] = n;
  });
  return out;
}
<<<SPLIT>>>
  /* Free-ticket verification settings, exactly as the Worker reports them. */
  const freeCfg = (ev.free_ticket_config && typeof ev.free_ticket_config === "object") ? ev.free_ticket_config : {};
  if($("#free_otp_enabled")) $("#free_otp_enabled").checked = ev.free_otp_enabled !== false;
  if($("#ip_abuse_enabled")) $("#ip_abuse_enabled").checked = ev.ip_abuse_enabled !== false;
  if($("#free_ticket_limit")) $("#free_ticket_limit").value = String(Math.min(5, Math.max(1, Number(ev.free_ticket_limit) || 1)));
  ["free_otp_ip_limit","free_otp_ip_window","free_register_ip_limit","free_register_ip_window"].forEach(function(id){
    const el = $("#" + id);
    if(el) el.value = (freeCfg[id] == null ? "" : String(freeCfg[id]));
  });
<<<SPLIT>>>
    /* Free-ticket protection. Both toggles default to ON, the per-email limit is
       clamped by the Worker, and blank thresholds are simply not sent. */
    free_otp_enabled: $("#free_otp_enabled") ? $("#free_otp_enabled").checked : true,
    ip_abuse_enabled: $("#ip_abuse_enabled") ? $("#ip_abuse_enabled").checked : true,
    free_ticket_limit: $("#free_ticket_limit") ? Number($("#free_ticket_limit").value) : 1,
    free_ticket_config: freeConfigPayload()
<<<SPLIT>>>
  /* Free-ticket figures for this event: counts only, never an address, an IP or a
     code, so this panel is safe on any dashboard. */
  const fs = ev.free_ticket_stats || null;
  const fh = $("#freeStats");
  if(fh){
    fh.innerHTML = fs
      ? ("<div class=\"row-flex\" style=\"justify-content:space-between;margin-bottom:8px\"><span class=\"small muted\">Free tickets issued</span><strong>" + Number(fs.free_tickets_issued || 0).toLocaleString("en-KE") + "</strong></div>"
        + "<div class=\"row-flex\" style=\"justify-content:space-between;margin-bottom:8px\"><span class=\"small muted\">Verified email addresses</span><strong>" + Number(fs.unique_verified_emails || 0).toLocaleString("en-KE") + "</strong></div>"
        + "<div class=\"row-flex\" style=\"justify-content:space-between;margin-bottom:8px\"><span class=\"small muted\">Codes sent</span><strong>" + Number(fs.otp_requests || 0).toLocaleString("en-KE") + "</strong></div>"
        + "<div class=\"row-flex\" style=\"justify-content:space-between\"><span class=\"small muted\">Throttled just now</span><strong>" + Number(fs.recent_ip_throttles || 0).toLocaleString("en-KE") + "</strong></div>"
        + "<p class=\"tiny faint\" style=\"margin:10px 0 0\">Counts only - never an address, an IP or a code. \"Throttled just now\" covers live rate-limit windows.</p>")
      : "<p class=\"small muted\" style=\"margin:0\">Free-ticket figures appear once the server has run migration 0006.</p>";
  }
<<<SPLIT>>>