try {
  step("free tickets");
  /* ===========================================================================
     Free tickets: email verification, IP abuse prevention, duplicates
     ---------------------------------------------------------------------------
     The Worker keys every stored value with HMAC-SHA256 over the deployment
     secret (PAYMENT_ENCRYPTION_KEY in this harness), so these tests can mint
     exactly the rows the real service would: a code, a continuation token and
     an email identity. Nothing here trusts a client-supplied price, address,
     quantity or event.
     ========================================================================= */
  var FREE_KEY = "harness-encryption-key-0123456789";
  async function hmac256Hex(secret, message){
    var key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    var sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return [].slice.call(new Uint8Array(sig)).map(function(b){ return b.toString(16).padStart(2, "0"); }).join("");
  }
  async function identHash(kind, value){ return (await hmac256Hex(FREE_KEY, kind + "|" + value)).slice(0, 48); }
  async function otpHashFor(token, code){ return await hmac256Hex(FREE_KEY, "otp|" + token + "|" + code); }
  function token32(){ return [].slice.call(crypto.getRandomValues(new Uint8Array(32)))
    .map(function(b){ return b.toString(16).padStart(2, "0"); }).join(""); }
  function isoAt(ms){ return new Date(ms).toISOString(); }
  function sessionRow(id, extra){
    var row = { id: id, session_token: token32(), event_id: EV_FREE, email: "seed@example.com",
      email_hash: null, name: "Seed Attendee", quantity: 1, ticket_type_id: TT_FREE, otp_hash: null,
      status: "pending", attempts: 0, resends: 0, ip_hash: null,
      expires_at: isoAt(Date.now() + 300000), last_sent_at: isoAt(Date.now()), verified_at: null,
      continue_hash: null, continue_expires_at: null, created_at: isoAt(Date.now()), consumed_at: null };
    for(var k in extra) row[k] = extra[k];
    db.state.free_ticket_sessions.push(row);
    return row;
  }

  /* ---- seed: three events on organizer A, only the first has a free type ---- */
  var EV_FREE = 91, EV_NO_OTP = 92, EV_NO_PRICE = 93;
  function seedEvent(id, extra){
    var row = { id: id, organizer_id: 1, title: "Harness Free Entry " + id, slug: "harness-free-" + id,
      description: "Harness event.", category: "Community", venue: "Nairobi", location: "Nairobi",
      event_date: "2027-12-31", start_time: "09:00", end_time: "17:00", poster_url: null,
      status: "active", is_featured: 0, sales_start: null, sales_end: null,
      payment_provider: "paystack", payment_mode: "own",
      free_otp_enabled: 1, free_ticket_limit: 1, ip_abuse_enabled: 1, free_ticket_config: null };
    for(var k in extra) row[k] = extra[k];
    rows("events").push(row);
    return row;
  }
  seedEvent(EV_FREE, {});
  seedEvent(EV_NO_OTP, { free_otp_enabled: 0 });
  seedEvent(EV_NO_PRICE, {});
  var TT_FREE = 911, TT_PAID = 912, TT_PAIDONLY = 931;
  function seedType(id, eventId, name, price){
    rows("ticket_types").push({ id: id, event_id: eventId, name: name, description: null, price: price,
      quantity: 20, sold: 0, sales_start: null, sales_end: null, status: "active" });
  }
  seedType(TT_FREE, EV_FREE, "Free Entry", 0);
  seedType(TT_PAID, EV_FREE, "VIP", 2500);
  seedType(TT_PAIDONLY, EV_NO_PRICE, "Regular", 1000);
  db.state.free_ticket_sessions = [];
  db.state.free_ticket_claims = [];

  var envF = makeEnv();
  /* Email ON for this group: the free-ticket code travels through the real Brevo
     pipeline in the Worker, so the whole request -> code -> ticket flow is
     exercised here instead of being short-circuited by EMAIL_DISABLED. */
  envF.BREVO_API_KEY = "xkeysib-test";
  envF.EMAIL_FROM = "tickets@princealexdigital.com";
  delete envF.EMAIL_DISABLED;
  /* Record every Brevo call, so the test can read the code out of the message the
     Worker actually built - the one place the six digits legitimately exist. */
  var BREVO_CALLS = [];
  var passthroughFetch = window.fetch;
  window.fetch = function(input, init){
    var href = (typeof input === "string") ? input : ((input && input.url) || String(input));
    if(href.indexOf("api.brevo.com") > -1 && init && init.body){
      try { BREVO_CALLS.push(typeof init.body === "string" ? init.body : String(init.body)); } catch(e){ }
    }
    return passthroughFetch.apply(this, arguments);
  };
  await connect("a", "paystack", { public_key: "pk_live_alice", secret_key: "sk_live_alice_secret" }, envF);
  await setActive("a", "paystack", envF);