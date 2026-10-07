<div class="panel">
          <div class="panel-head"><h2>Free tickets</h2></div>
          <div class="panel-body" id="freeStats"><p class="small muted" style="margin:0">Loading...</p></div>
        </div>
<<<SPLIT>>>
    /* Free-ticket defaults chosen on the create form. The thresholds keep their
       platform values, and both protections stay on unless the organizer says
       otherwise - the Worker clamps everything again on the way in. */
    free_otp_enabled: $("#free_otp_enabled") ? $("#free_otp_enabled").checked : true,
    ip_abuse_enabled: $("#ip_abuse_enabled") ? $("#ip_abuse_enabled").checked : true,
    free_ticket_limit: $("#free_ticket_limit") ? Number($("#free_ticket_limit").value) : 1
<<<SPLIT>>>