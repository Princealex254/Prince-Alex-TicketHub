/* Step 2: check the code, then complete the registration in the same breath -
   the server hands back a single-use continuation token that is spent here. */
async function confirmOtp(){
  const btn = $("#otpVerifyBtn");
  const code = digits($("#otpCode").value);
  if(code.length !== 6){ setErr("otpCode", "Enter the 6-digit code from the email."); return; }
  setErr("otpCode", "");
  btn.disabled = true; btn.textContent = "Checking your code..."; hideOtpAlert();
  let continueToken = "";
  try {
    const res = await api("/api/tickets/free/verify/confirm", { auth: false, method: "POST", body: {
      session_token: OTP_SESSION, otp: code
    } });
    continueToken = res.continue_token || "";
  } catch (err) {
    if(err && err.code) console.warn("checkout: free code check failed [" + err.code + "] status " + (err.status || "?"));
    showOtpAlert("err", err.message);
    btn.disabled = false; btn.textContent = "Verify and get my ticket";
    /* Only a fresh code can rescue a session that has expired or run out of tries. */
    if(["OTP_EXPIRED","SESSION_EXPIRED","SESSION_CLOSED","OTP_ATTEMPTS"].indexOf(err.code) > -1){
      if(OTP_TIMER){ clearInterval(OTP_TIMER); OTP_TIMER = null; }
      const rb = $("#otpResendBtn"); if(rb){ rb.disabled = false; rb.textContent = "Send a new code"; }
    }
    return;
  }
  if(!continueToken){
    showOtpAlert("err", "We could not confirm the verification. Please try again.");
    btn.disabled = false; btn.textContent = "Verify and get my ticket";
    return;
  }
  btn.textContent = "Issuing your ticket...";
  try {
    const res = await api("/api/tickets/free/register", { auth: false, method: "POST", body: {
      continue_token: continueToken, phone: $("#phone").value.trim()
    } });
    showDone(res);
  } catch (err) {
    if(err && err.code) console.warn("checkout: free registration failed [" + err.code + "] status " + (err.status || "?"));
    showOtpAlert("err", err.message || "We could not complete your registration. Please try again.");
    btn.disabled = false; btn.textContent = "Verify and get my ticket";
  }
}