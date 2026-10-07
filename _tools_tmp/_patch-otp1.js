/* ============================================================
   Free tickets: email verification, then registration
   ------------------------------------------------------------
   When every selected ticket costs KSh 0 the payment step is
   replaced by a one-time-code step. This page is never trusted:
   the Worker re-checks the price, mints the code, applies the
   per-email free-ticket limit and issues the ticket only after
   the code is confirmed. The paid flow is left untouched.
   ============================================================ */
let FREE_MODE = false;
let OTP_SESSION = null;     /* session_token from the request step */
let OTP_TYPE_ID = null;     /* the free ticket type the code covers */
let OTP_TIMER = null;       /* resend cooldown ticker */
function digits(v){ return String(v == null ? "" : v).replace(/\D/g, ""); }
function priceOfType(typeId){
  const t = TICKETS.filter(x => String(x.id) === String(typeId))[0];
  return t ? Number(t.price || 0) : null;
}
/* Free mode needs at least one selected line and EVERY line priced at 0. One
   paid line keeps the whole selection on the normal payment path. */
function isFreeSelection(){
  if(!ITEMS.length) return false;
  return ITEMS.every(i => priceOfType(i.ticket_type_id) === 0);
}
function enterFreeMode(){
  FREE_MODE = true;
  const note = $("#freeNote");
  if(note){
    note.innerHTML = "<strong>This is a free ticket.</strong> Nothing is charged. We email a single-use code to confirm your address, then your ticket is issued immediately.";
    note.classList.remove("hidden");
  }
  const pay = $("#payBlock"); if(pay) pay.classList.add("hidden");
  const sum = $("#summaryTotal"); if(sum) sum.textContent = "Free";
  const summaryNote = $("#summaryNote");
  if(summaryNote) summaryNote.textContent = "Free tickets are confirmed by email verification. The server checks every claim against the free-ticket limit for this event before a ticket is issued.";
  const btn = $("#payBtn"); if(btn) btn.textContent = "Send verification code";
  const trust = $("#payTrust"); if(trust) trust.textContent = "Your ticket is only issued after the one-time code confirms your email address.";
}
/* One primary button, two paths: the paid flow, or the free one. */
async function onPrimaryAction(){
  if(FREE_MODE) return startFreeVerification();
  return pay();
}
function showOtpAlert(kind, msg){
  const box = $("#otpAlert"); if(!box) return;
  box.className = "alert " + kind;
  box.textContent = msg;
  box.classList.remove("hidden");
}
function hideOtpAlert(){
  const box = $("#otpAlert"); if(!box) return;
  box.classList.add("hidden"); box.textContent = "";
}
function startResendCooldown(seconds){
  const btn = $("#otpResendBtn");
  let left = Math.max(1, Math.round(Number(seconds) || 60));
  if(OTP_TIMER){ clearInterval(OTP_TIMER); OTP_TIMER = null; }
  const paint = () => {
    if(!btn) return;
    if(left > 0){ btn.disabled = true; btn.textContent = "Resend in " + left + "s"; }
    else { btn.disabled = false; btn.textContent = "Resend code"; }
  };
  paint();
  OTP_TIMER = setInterval(() => {
    left -= 1;
    if(left <= 0){ clearInterval(OTP_TIMER); OTP_TIMER = null; }
    paint();
  }, 1000);
}
/* The code screen replaces the details form (and the whole payment block). */
function showOtpStep(res){
  OTP_SESSION = res.session_token;
  if(!OTP_TYPE_ID) OTP_TYPE_ID = ITEMS[0] && ITEMS[0].ticket_type_id;
  const masked = $("#otpEmail"); if(masked) masked.textContent = res.email_masked || "your email address";
  const code = $("#otpCode"); if(code) code.value = "";
  setErr("otpCode", "");
  const hint = $("#otpHint");
  if(hint) hint.textContent = "The code expires in " + Math.max(1, Math.round(Number(res.expires_in || 300) / 60)) + " minutes and can only be used once.";
  const form = $("#checkoutForm"); if(form) form.classList.add("hidden");
  const payBlock = $("#payBlock"); if(payBlock) payBlock.classList.add("hidden");
  const payBtn = $("#payBtn"); if(payBtn) payBtn.classList.add("hidden");
  const terms = $("#termsLine"); if(terms) terms.classList.add("hidden");
  const otp = $("#otpBlock"); if(otp) otp.classList.remove("hidden");
  showAlert("ok", res.message || "We sent your verification code.");
  startResendCooldown(Number(res.resend_after || 60));
  if(code) code.focus();
}