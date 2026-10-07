/* ---- 9. the whole flow, over the real email pipeline ---- */
  var brevoBody = function(index){
    var raw = BREVO_CALLS[index] || BREVO_CALLS[BREVO_CALLS.length - 1] || "";
    try { return JSON.parse(raw); } catch(e){ return {}; }
  };
  var happyEmail = "happy@example.com";
  BREVO_CALLS.length = 0;
  var asked = await send("/api/tickets/free/verify/request",
    { event_id: EV_FREE, ticket_type_id: TT_FREE, quantity: 1, full_name: "Happy Tester", email: happyEmail },
    envF, {}, "10.0.11.1");
  ck("a code request is answered with a masked address and a verification session",
    asked.status === 200 && String(asked.body.session_token || "").length >= 32
      && asked.body.email_masked === "h***y@example.com" && Number(asked.body.expires_in) === 300
      && Number(asked.body.attempts_allowed) === 5 && Number(asked.body.resend_after) === 60,
    asked.status + " " + JSON.stringify({ masked: asked.body.email_masked, code: asked.body.code || null }));
  ck("the code is delivered by the ordinary email pipeline and never returned to the caller",
    BREVO_CALLS.length >= 1 && asked.body.otp === undefined && asked.body.code === undefined
      && /verification code/i.test(String((brevoBody(0) || {}).subject || "")),
    "brevo calls=" + BREVO_CALLS.length + " subject=" + String((brevoBody(0) || {}).subject || ""));
  var sentCode = (String((brevoBody(0) || {}).textContent || "").match(/verification code is:\s*(\d{6})/) || [])[1] || "";
  var happyRow = db.state.free_ticket_sessions.filter(function(s){
    return s.session_token === asked.body.session_token; })[0] || {};
  ck("the emailed code is six digits and is stored only as a keyed hash",
    /^\d{6}$/.test(sentCode) && String(happyRow.otp_hash || "") !== sentCode
      && /^[0-9a-f]{64}$/.test(String(happyRow.otp_hash || "")),
    "digits=" + sentCode.length + " stored=" + String(happyRow.otp_hash || "").slice(0, 12) + "...");
  var happyConfirm = await send("/api/tickets/free/verify/confirm",
    { session_token: asked.body.session_token, otp: sentCode }, envF, {}, "10.0.11.2");
  var happyReg = await send("/api/tickets/free/register",
    { continue_token: happyConfirm.body.continue_token, phone: "+254700000001" }, envF, {}, "10.0.11.3");
  ck("code -> verified -> ticket works end to end without trusting the page",
    happyConfirm.status === 200 && happyReg.status === 201 && (happyReg.body.tickets || []).length === 1
      && Number((happyReg.body.order || {}).amount) === 0
      && ((happyReg.body.verification || {}).verified === true),
    happyConfirm.status + "/" + happyReg.status + " " +
      JSON.stringify({ tickets: (happyReg.body.tickets || []).length, code: happyReg.body.code || null }));
  ck("the claimed ticket is emailed to the attendee as usual",
    BREVO_CALLS.length >= 2, "brevo calls=" + BREVO_CALLS.length);
} catch(e){
  ck("the free-ticket group ran to completion", false, (e && (e.stack || e.message)) || String(e));
}