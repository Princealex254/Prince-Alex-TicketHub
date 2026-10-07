/* ---- 6. the paid path refuses an unverified free order ---- */
  var freeOrder = await send("/api/orders", { event_id: EV_FREE,
    items: [{ ticket_type_id: TT_FREE, quantity: 1 }],
    customer: { full_name: "Gate Tester", email: "gate@example.com", phone: "+254712345678" } }, envF, {}, "10.0.8.1");
  ck("a free ticket can still be ordered, so the gate is what protects it",
    freeOrder.status === 201 && Number((freeOrder.body.order || {}).amount) === 0,
    freeOrder.status + " amount=" + String((freeOrder.body.order || {}).amount));
  var gate = await send("/api/payments/create",
    { reference: (freeOrder.body.order || {}).reference, checkout_proof: freeOrder.body.checkout_proof },
    envF, {}, "10.0.8.1");
  ck("an order that skipped verification is refused at the payment step",
    gate.status === 403 && gate.body.code === "FREE_VERIFICATION_REQUIRED", gate.status + " " + gate.body.code);

  /* ---- 7. registration: the session's own data is what gets issued ---- */
  var cToken = right.body.continue_token;
  var tamper = await send("/api/tickets/free/register",
    { continue_token: cToken, phone: "+254712345678", quantity: 9, event_id: EV_NO_PRICE }, envF, {}, "10.0.9.1");
  ck("a payload that edits the event is refused outright",
    tamper.status === 403 && tamper.body.code === "SESSION_EVENT_MISMATCH", tamper.status + " " + tamper.body.code);
  var tamper2 = await send("/api/tickets/free/register",
    { continue_token: cToken, phone: "+254712345678", email: "someone.else@example.com" }, envF, {}, "10.0.9.2");
  ck("a payload that edits the address is refused outright",
    tamper2.status === 403 && tamper2.body.code === "SESSION_EMAIL_MISMATCH", tamper2.status + " " + tamper2.body.code);
  var reg = await send("/api/tickets/free/register",
    { continue_token: cToken, phone: "+254712345678" }, envF, {}, "10.0.9.3");
  ck("a verified email completes the registration through the normal ticket path",
    reg.status === 201 && Number((reg.body.order || {}).amount) === 0 && (reg.body.tickets || []).length === 1
      && /^PAT-/.test(String(((reg.body.tickets || [])[0] || {}).ticket_number || ""))
      && String(((reg.body.tickets || [])[0] || {}).qr_image_url || "").indexOf("/qr.png") > -1,
    reg.status + " " + JSON.stringify({ amount: (reg.body.order || {}).amount,
      tickets: (reg.body.tickets || []).length, code: reg.body.code || null }));
  var regAgain = await send("/api/tickets/free/register",
    { continue_token: cToken, phone: "+254712345678" }, envF, {}, "10.0.9.4");
  ck("the continuation token is burned on use",
    regAgain.status === 409 && regAgain.body.code === "ALREADY_REGISTERED" && good.status === "consumed",
    regAgain.status + " " + regAgain.body.code + " session=" + good.status);
  var limitHash = await identHash("email", sEmail);
  var mine = rows("free_ticket_claims").filter(function(c){ return String(c.email_hash) === limitHash; });
  ck("the claim row is what holds the slot, and it never carries the address",
    mine.length === 1 && String(mine[0].status) === "active" && String(mine[0].email_hash).indexOf("@") < 0
      && Number(mine[0].quantity) === 1,
    mine.length + " claim(s) status=" + (mine[0] || {}).status);

  /* ---- 8. duplicate prevention: the per-email limit is the ceiling ---- */
  /* Creating an order already reserves inventory, so the honest comparison is the
     stock either side of the refusal - not an absolute number. */
  var soldBeforeRefusal = Number((rows("ticket_types").filter(function(t){ return Number(t.id) === TT_FREE; })[0] || {}).sold);
  var dupToken = token32();
  sessionRow(5005, { email: sEmail, email_hash: limitHash, status: "verified", verified_at: isoAt(Date.now()),
    continue_hash: await identHash("continue", dupToken), continue_expires_at: isoAt(Date.now() + 600000) });
  var dup = await send("/api/tickets/free/register",
    { continue_token: dupToken, phone: "+254712345678" }, envF, {}, "10.0.10.1");
  ck("a second free ticket for the same address is refused by the per-email limit",
    dup.status === 409 && dup.body.code === "FREE_LIMIT_REACHED", dup.status + " " + dup.body.code);
  var activeForEmail = rows("free_ticket_claims").filter(function(c){
    return String(c.email_hash) === limitHash && c.status === "active"; }).length;
  var freeStock = rows("ticket_types").filter(function(t){ return Number(t.id) === TT_FREE; })[0];
  ck("a refused registration consumes no slot and returns its inventory",
    activeForEmail === 1 && Number(freeStock.sold) === soldBeforeRefusal,
    "active=" + activeForEmail + " sold " + soldBeforeRefusal + " -> " + freeStock.sold);