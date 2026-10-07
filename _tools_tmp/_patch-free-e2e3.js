/* ---- 3. the code itself: wrong guesses cost tries, the right one is spent ---- */
  var sCode = "135790", sEmail = "limit@example.com";
  var good = sessionRow(5001, { email: sEmail, email_hash: await identHash("email", sEmail) });
  good.otp_hash = await otpHashFor(good.session_token, sCode);
  var wrong1 = await send("/api/tickets/free/verify/confirm",
    { session_token: good.session_token, otp: "000000" }, envF, {}, "10.0.2.1");
  ck("a wrong code is refused and the try is counted against the session",
    wrong1.status === 400 && wrong1.body.code === "OTP_INVALID"
      && /attempts? left/i.test(String(wrong1.body.error || wrong1.body.message || "")),
    wrong1.status + " " + wrong1.body.code + " :: " + (wrong1.body.error || wrong1.body.message));
  ck("the stored code is a keyed HMAC, never the six digits",
    String(good.otp_hash) !== sCode && /^[0-9a-f]{64}$/.test(String(good.otp_hash)) && Number(good.attempts) === 1,
    "attempts=" + good.attempts + " hash=" + String(good.otp_hash).slice(0, 12) + "...");
  var right = await send("/api/tickets/free/verify/confirm",
    { session_token: good.session_token, otp: sCode }, envF, {}, "10.0.2.2");
  ck("the right code verifies the address and mints a continuation token",
    right.status === 200 && right.body.verified === true && String(right.body.continue_token || "").length >= 32
      && right.body.email_masked === "l***t@example.com" && good.status === "verified",
    right.status + " " + JSON.stringify({ masked: right.body.email_masked, status: good.status }));
  var reuse = await send("/api/tickets/free/verify/confirm",
    { session_token: good.session_token, otp: sCode }, envF, {}, "10.0.2.3");
  ck("a successful code can never be used a second time",
    reuse.status === 409 && reuse.body.code === "ALREADY_VERIFIED", reuse.status + " " + reuse.body.code);
  var burn = sessionRow(5002, { email: "burn@example.com" });
  burn.otp_hash = await otpHashFor(burn.session_token, "246810");
  var lastTry = null;
  for(var i = 0; i < 6; i++){
    lastTry = await send("/api/tickets/free/verify/confirm",
      { session_token: burn.session_token, otp: "999999" }, envF, {}, "10.0.3." + i);
  }
  ck("five wrong codes use up the session's whole try budget",
    lastTry.status === 429 && lastTry.body.code === "OTP_ATTEMPTS" && burn.status === "expired",
    lastTry.status + " " + lastTry.body.code + " status=" + burn.status);
  var stale = sessionRow(5003, { email: "late@example.com", expires_at: isoAt(Date.now() - 1000) });
  stale.otp_hash = await otpHashFor(stale.session_token, "555555");
  var late = await send("/api/tickets/free/verify/confirm",
    { session_token: stale.session_token, otp: "555555" }, envF, {}, "10.0.4.0");
  ck("a code that has expired is refused even when it is correct",
    late.status === 410 && late.body.code === "OTP_EXPIRED", late.status + " " + late.body.code);

  /* ---- 4. the resend cooldown is enforced by the server ---- */
  var resent = sessionRow(5004, { email: "resend@example.com" });
  resent.otp_hash = await otpHashFor(resent.session_token, "111222");
  var cooldown = await send("/api/tickets/free/verify/request",
    { event_id: EV_FREE, session_token: resent.session_token }, envF, {}, "10.0.5.0");
  ck("a resend inside the cooldown is refused with the wait the client must observe",
    cooldown.status === 429 && cooldown.body.code === "RESEND_COOLDOWN", cooldown.status + " " + cooldown.body.code);

  /* ---- 5. one connection cannot flood the code endpoint ---- */
  var floodIp = "10.0.6.9", flood = [];
  for(var f = 0; f < 6; f++){
    flood.push(await send("/api/tickets/free/verify/request",
      { event_id: EV_FREE, ticket_type_id: TT_FREE, quantity: 1, full_name: "Flood Tester",
        email: "flood" + f + "@example.com" }, envF, {}, floodIp));
  }
  ck("the sixth code request from one IP address is throttled",
    flood[5].status === 429 && flood[5].body.code === "RATE_LIMITED" &&
      flood.slice(0, 5).every(function(r){ return r.status !== 429; }),
    "statuses " + flood.map(function(r){ return r.status; }).join(","));
  var otherIp = await send("/api/tickets/free/verify/request",
    { event_id: EV_FREE, ticket_type_id: TT_FREE, quantity: 1, full_name: "Other Visitor",
      email: "other@example.com" }, envF, {}, "10.0.7.9");
  ck("the throttle is per address, so another visitor is unaffected",
    otherIp.status !== 429, "other IP -> " + otherIp.status + " " + String(otherIp.body.code || ""));