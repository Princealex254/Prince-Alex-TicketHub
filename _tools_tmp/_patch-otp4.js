/* The ticket the Worker just issued: number, type and its QR image. */
function showDone(res){
  const order = res.order || {};
  const tickets = res.tickets || order.tickets || [];
  if(OTP_TIMER){ clearInterval(OTP_TIMER); OTP_TIMER = null; }
  const otp = $("#otpBlock"); if(otp) otp.classList.add("hidden");
  const done = $("#doneBlock"); if(done) done.classList.remove("hidden");
  const title = $("#doneTitle");
  if(title) title.textContent = tickets.length === 1 ? "Your free ticket is confirmed" : "Your free tickets are confirmed";
  const text = $("#doneText");
  if(text) text.textContent = res.message || "A copy has been emailed to you with the QR code for entry.";
  const box = $("#doneTickets");
  if(box){
    box.innerHTML = tickets.map(t => {
      const qr = safeUrl(t.qr_image_url || t.qr_url);
      return "<div style=\"display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:10px\">"
        + (qr ? "<img src=\"" + esc(qr) + "\" alt=\"Ticket QR code\" style=\"width:74px;height:74px;flex:none;border-radius:8px;background:#fff\" />" : "")
        + "<div style=\"min-width:0\">"
        + "<div class=\"small\"><strong>" + esc(t.ticket_number || "") + "</strong></div>"
        + "<div class=\"tiny faint\">" + esc(t.ticket_type_name || "Free ticket") + (t.attendee_name ? " &middot; " + esc(t.attendee_name) : "") + "</div>"
        + "<div class=\"tiny faint\">Order " + esc(order.order_number || "") + "</div>"
        + "</div></div>";
    }).join("");
    if(!tickets.length) box.innerHTML = "<p class=\"small muted\" style=\"margin-top:10px\">Your ticket is in your inbox. Open \"My Ticket\" to view it any time.</p>";
  }
  try { sessionStorage.removeItem(KEY); } catch (err) {}
  Turnstile.reset();
}
/* Back to the details form. The code the server already sent stays valid until it
   expires, so nothing is cancelled here - the session is simply left alone. */
function backToDetails(){
  if(OTP_TIMER){ clearInterval(OTP_TIMER); OTP_TIMER = null; }
  hideOtpAlert(); setErr("otpCode", "");
  const otp = $("#otpBlock"); if(otp) otp.classList.add("hidden");
  const form = $("#checkoutForm"); if(form) form.classList.remove("hidden");
  const terms = $("#termsLine"); if(terms) terms.classList.remove("hidden");
  if(!FREE_MODE){ const payBlock = $("#payBlock"); if(payBlock) payBlock.classList.remove("hidden"); }
  const btn = $("#payBtn");
  if(btn){ btn.disabled = false; btn.classList.remove("hidden"); btn.textContent = FREE_MODE ? "Send verification code" : "Pay now"; }
  hideAlert();
}