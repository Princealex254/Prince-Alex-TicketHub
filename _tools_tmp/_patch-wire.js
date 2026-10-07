/* Free-ticket verification wiring: one primary button, plus the code screen. */
  if($("#payBtn")) $("#payBtn").addEventListener("click", onPrimaryAction);
  if($("#otpVerifyBtn")) $("#otpVerifyBtn").addEventListener("click", confirmOtp);
  if($("#otpResendBtn")) $("#otpResendBtn").addEventListener("click", resendOtp);
  if($("#otpBackBtn")) $("#otpBackBtn").addEventListener("click", backToDetails);
  const otpInput = $("#otpCode");
  if(otpInput){
    otpInput.addEventListener("input", () => { otpInput.value = digits(otpInput.value).slice(0, 6); setErr("otpCode", ""); });
    otpInput.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); confirmOtp(); } });
  }