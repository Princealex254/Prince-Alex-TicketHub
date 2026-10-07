/* Step 1: ask the Worker for a code. The Worker resolves the free ticket type,
   the per-email limit and every rate limit - this page only reports the answer.
   One free ticket type is claimed per registration, so the button sits on the
   first selected free line. */
async function startFreeVerification(){
  const btn = $("#payBtn");
  if(!ITEMS.length){ toast("Your selection is empty", "err"); return; }
  if(!validate()){ showAlert("err", "Please check the highlighted fields and try again."); return; }
  const token = Turnstile.token();
  if(Turnstile.configured() && !token){ showAlert("err", "Please complete the bot protection check above, then try again."); Turnstile.reset(); return; }
  if(ITEMS.length > 1){
    showAlert("info", "One free ticket type can be claimed per registration. Complete this one, then register again for the others.");
  }
  OTP_TYPE_ID = ITEMS[0].ticket_type_id;
  btn.disabled = true; btn.textContent = "Sending your code..."; hideAlert();
  try {
    const res = await api("/api/tickets/free/verify/request", { auth: false, method: "POST", body: {
      event_id: EVENT && EVENT.id,
      ticket_type_id: OTP_TYPE_ID,
      quantity: ITEMS[0].quantity,
      full_name: $("#full_name").value.trim(),
      email: $("#email").value.trim(),
      phone: $("#phone").value.trim(),
      turnstile_token: token
    } });
    showOtpStep(res);
  } catch (err) {
    if(err && err.code) console.warn("checkout: free verification request failed [" + err.code + "] status " + (err.status || "?"));
    showAlert("err", err.message);
    Turnstile.reset();
    btn.disabled = false; btn.textContent = "Send verification code";
  }
}
/* A resend re-uses the same session: the server enforces the cooldown and the
   reissue cap, so a tap here can never outrun them. */
async function resendOtp(){
  const btn = $("#otpResendBtn");
  if(!OTP_SESSION) return;
  btn.disabled = true; btn.textContent = "Sending..."; hideOtpAlert();
  try {
    const res = await api("/api/tickets/free/verify/request", { auth: false, method: "POST", body: {
      event_id: EVENT && EVENT.id, session_token: OTP_SESSION
    } });
    const code = $("#otpCode"); if(code) code.value = "";
    setErr("otpCode", "");
    const masked = $("#otpEmail"); if(masked && res.email_masked) masked.textContent = res.email_masked;
    showOtpAlert("ok", res.message || "A new code is on its way.");
    startResendCooldown(Number(res.resend_after || 60));
  } catch (err) {
    if(err && err.code) console.warn("checkout: free code resend failed [" + err.code + "] status " + (err.status || "?"));
    showOtpAlert("err", err.message);
    startResendCooldown(Number(err.retryAfter || 0) > 0 ? Number(err.retryAfter) : 60);
  }
}