/* ---- 1. the guards that stop a code being issued at all ---- */
  var offOtp = await send("/api/tickets/free/verify/request",
    { event_id: EV_NO_OTP, full_name: "Jane Wanjiru", email: "jane@example.com", quantity: 1 }, envF, {}, "10.0.0.1");
  ck("an event with verification switched off never issues a code",
    offOtp.status === 409 && offOtp.body.code === "OTP_DISABLED", offOtp.status + " " + offOtp.body.code);
  var gone = await send("/api/tickets/free/verify/request",
    { event_id: 9999, full_name: "Jane Wanjiru", email: "jane@example.com" }, envF, {}, "10.0.0.2");
  ck("an unknown event is refused before anything is generated",
    gone.status === 404 && gone.body.code === "NOT_FOUND", gone.status + " " + gone.body.code);
  var noType = await send("/api/tickets/free/verify/request",
    { event_id: EV_NO_PRICE, full_name: "Jane Wanjiru", email: "jane@example.com", quantity: 1 }, envF, {}, "10.0.0.3");
  ck("an event with no price-0 ticket type has nothing to verify",
    noType.status === 409 && noType.body.code === "NO_FREE_TICKETS", noType.status + " " + noType.body.code);
  var envNoKey = makeEnv();
  delete envNoKey.PAYMENT_ENCRYPTION_KEY;
  var noKey = await send("/api/tickets/free/verify/request",
    { event_id: EV_FREE, full_name: "Jane Wanjiru", email: "jane@example.com", quantity: 1 }, envNoKey, {}, "10.0.0.4");
  ck("a deployment with no key material refuses to start a verification",
    noKey.status === 500 && noKey.body.code === "OTP_KEY_MISSING", noKey.status + " " + noKey.body.code);
  var badEmail = await send("/api/tickets/free/verify/request",
    { event_id: EV_FREE, full_name: "Jane Wanjiru", email: "not-an-address" }, envF, {}, "10.0.0.5");
  ck("a malformed address is rejected before a session is created",
    badEmail.status === 422 && db.state.free_ticket_sessions.length === 0,
    badEmail.status + " sessions=" + db.state.free_ticket_sessions.length);

  /* ---- 2. none of the endpoints confirm which sessions or tokens exist ---- */
  var bogus = await send("/api/tickets/free/verify/confirm",
    { session_token: token32(), otp: "123456" }, envF, {}, "10.0.1.1");
  var noToken = await send("/api/tickets/free/verify/confirm", { otp: "123456" }, envF, {}, "10.0.1.2");
  ck("a made-up verification session is refused without revealing anything",
    bogus.status === 400 && bogus.body.code === "OTP_INVALID" && noToken.status === 422,
    bogus.status + " " + bogus.body.code + " / missing token " + noToken.status);
  var bogusReg = await send("/api/tickets/free/register",
    { continue_token: token32(), phone: "+254712345678" }, envF, {}, "10.0.1.3");
  ck("an unknown continuation token cannot issue a ticket",
    bogusReg.status === 401 && bogusReg.body.code === "VERIFY_REQUIRED", bogusReg.status + " " + bogusReg.body.code);