/* ---- 7. checkout: free-ticket email verification ---- */
    ck("checkout has the verification and success blocks",
      count(co, 'id="otpBlock"') === 1 && count(co, 'id="doneBlock"') === 1 && count(co, 'id="otpCode"') === 1
        && count(co, 'id="otpVerifyBtn"') === 1 && count(co, 'id="otpResendBtn"') === 1
        && count(co, 'id="otpBackBtn"') === 1 && count(co, 'id="otpEmail"') === 1,
      "otpBlock=" + count(co, 'id="otpBlock"') + " doneBlock=" + count(co, 'id="doneBlock"'));
    ck("checkout keeps the whole payment UI in one wrapper it can hide",
      count(co, 'id="payBlock"') === 1 && /<div id="payBlock">[\s\S]*?id="payTrust2"[\s\S]*?<\/div>/.test(co)
        && count(co, 'id="summaryNote"') === 1 && count(co, 'id="termsLine"') === 1);
    ck("checkout only enters free mode for an all-zero selection",
      /function isFreeSelection\(\)\{[\s\S]*?ITEMS\.every\(i => priceOfType\(i\.ticket_type_id\) === 0\)/.test(co)
        && /if\(isFreeSelection\(\)\) enterFreeMode\(\);/.test(co));
    ck("checkout calls the three free-ticket endpoints",
      count(co, "/api/tickets/free/verify/request") === 2 && count(co, "/api/tickets/free/verify/confirm") === 1
        && count(co, "/api/tickets/free/register") === 1,
      "request=" + count(co, "/api/tickets/free/verify/request") + " confirm=" + count(co, "/api/tickets/free/verify/confirm")
        + " register=" + count(co, "/api/tickets/free/register"));
    ck("checkout sends exactly the fields the free endpoints require",
      /quantity: ITEMS\[0\]\.quantity/.test(co) && /ticket_type_id: OTP_TYPE_ID/.test(co)
        && /session_token: OTP_SESSION, otp: code/.test(co)
        && /continue_token: continueToken, phone: \$\("#phone"\)\.value\.trim\(\)/.test(co));
    ck("checkout only sends the Turnstile token on the step that sends the email",
      /turnstile_token: token/.test(co)
        && !/session_token: OTP_SESSION, otp: code[\s\S]{0,200}?turnstile_token/.test(co));
    ck("checkout honours the server's resend cooldown",
      /startResendCooldown\(Number\(res\.resend_after/.test(co) && /"Resend in " \+ left \+ "s"/.test(co)
        && /startResendCooldown\(Number\(err\.retryAfter/.test(co));
    ck("checkout reveals a ticket only from the Worker's own answer",
      /const tickets = res\.tickets \|\| order\.tickets \|\| \[\]/.test(co) && /function showDone\(res\)/.test(co)
        && /qr_image_url/.test(co));
    var coBoot2 = bootScript("checkout/index.html");
    ck("checkout boots the free-ticket flow",
      /addEventListener\("click", onPrimaryAction\)/.test(coBoot2) && /addEventListener\("click", confirmOtp\)/.test(coBoot2)
        && /addEventListener\("click", resendOtp\)/.test(coBoot2) && /addEventListener\("click", backToDetails\)/.test(coBoot2),
      coBoot2 ? "boot script " + coBoot2.length + " chars" : "no boot script");
    ck("checkout defines each free-ticket helper exactly once",
      count(co, "function isFreeSelection()") === 1 && count(co, "function enterFreeMode()") === 1
        && count(co, "async function startFreeVerification()") === 1 && count(co, "async function resendOtp()") === 1
        && count(co, "async function confirmOtp()") === 1 && count(co, "function showDone(") === 1
        && count(co, "function backToDetails()") === 1 && count(co, "function digits(") === 1,
      "isFreeSelection=" + count(co, "function isFreeSelection()") + " confirmOtp=" + count(co, "async function confirmOtp()"));

    /* ---- 8. the organizer controls for free tickets ---- */
    ck("edit-event exposes every free-ticket setting",
      count(ee, 'id="free_otp_enabled"') === 1 && count(ee, 'id="ip_abuse_enabled"') === 1
        && count(ee, 'id="free_ticket_limit"') === 1 && count(ee, 'id="free_otp_ip_limit"') === 1
        && count(ee, 'id="free_otp_ip_window"') === 1 && count(ee, 'id="free_register_ip_limit"') === 1
        && count(ee, 'id="free_register_ip_window"') === 1,
      "free_otp_enabled=" + count(ee, 'id="free_otp_enabled"') + " free_ticket_limit=" + count(ee, 'id="free_ticket_limit"'));
    ck("edit-event loads and saves every free-ticket setting",
      /ev\.free_otp_enabled !== false/.test(ee) && /ev\.ip_abuse_enabled !== false/.test(ee)
        && /free_otp_enabled: \$\("#free_otp_enabled"\) \? \$\("#free_otp_enabled"\)\.checked : true/.test(ee)
        && /free_ticket_limit: \$\("#free_ticket_limit"\) \? Number/.test(ee)
        && /free_ticket_config: freeConfigPayload\(\)/.test(ee));
    ck("edit-event only sends the four documented thresholds",
      /\["free_otp_ip_limit","free_otp_ip_window","free_register_ip_limit","free_register_ip_window"\]\.forEach/.test(ee)
        && count(ee, "function freeConfigPayload()") === 1 && count(ee, "function intOrNull(") === 1);
    ck("edit-event reports the free-ticket counts it is given",
      /ev\.free_ticket_stats/.test(ee) && count(ee, 'id="freeStats"') === 1 && /free_tickets_issued/.test(ee));
    ck("create-event sets the same free-ticket defaults",
      count(ce, 'id="free_otp_enabled"') === 1 && count(ce, 'id="ip_abuse_enabled"') === 1
        && count(ce, 'id="free_ticket_limit"') === 1
        && /free_otp_enabled: \$\("#free_otp_enabled"\) \? \$\("#free_otp_enabled"\)\.checked : true/.test(ce));