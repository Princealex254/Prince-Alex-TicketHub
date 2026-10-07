const fs = require('fs');
const path = require('path');

const paths = [
  path.resolve(__dirname, '..', 'worker', 'emails.js'),
  path.resolve(__dirname, '..', 'worker', 'worker.js')
];

const headerText = `function brandHeader(brand, chip){
  return '<tr><td bgcolor="' + COLORS.soft + '" class="pad" style="background:' + COLORS.soft + ';border-bottom:1px solid ' + COLORS.line + ';padding:18px 26px 16px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
    '<td valign="middle">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td width="34" valign="middle"><div style="width:34px;height:34px;border-radius:10px;background:' + COLORS.primary + ';opacity:.12;border:1px solid rgba(76,111,255,.18);text-align:center;font:800 12px/34px ' + EMAIL_FONT + ';color:' + COLORS.primary + ';letter-spacing:.04em">T</div></td>' +
      '<td valign="middle" style="padding-left:12px">' +
        '<div style="font:700 16px/1.3 ' + EMAIL_FONT + ';color:' + COLORS.ink + '">' + esc(brand.product) + "</div>" +
        (brand.tagline ? '<div style="font:400 11px/1.4 ' + EMAIL_FONT + ';color:' + COLORS.muted + '">' + esc(brand.tagline) + "</div>" : "") +
      "</td></tr></table>" +
    "</td>" +
    '<td align="right" valign="middle" class="hide-sm"><span style="display:inline-block;padding:6px 10px;border-radius:999px;background:#FFFFFF;border:1px solid ' + COLORS.line + ';font:700 10px/1.2 ' + EMAIL_FONT + ';color:' + COLORS.primary + ';letter-spacing:.06em;text-transform:uppercase">' + esc(chip || "Update") + "</span></td>" +
    "</tr></table></td></tr>";
}`;

const footerText = `function brandFooter(brand, links, legal){
  const helpLine = brand.support_email
    ? '<div style="font:400 13px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.body + '">Questions about this email? Write to <a href="mailto:' +
      esc(brand.support_email) + '" style="color:' + COLORS.primary + ';font-weight:600">' + esc(brand.support_email) + "</a>" +
      (brand.support_phone ? " or call " + esc(brand.support_phone) : "") + ".</div>"
    : "";
  const navItems = [
    ["Browse events", linkOf(links, "events", "")],
    ["My tickets", linkOf(links, "order", "")],
    ["Dashboard", linkOf(links, "organizer", "")],
    ["Terms", linkOf(links, "terms", "")],
    ["Privacy", linkOf(links, "privacy", "")],
    ["Website", /^https?:\/\//i.test(String(brand.website || "")) ? brand.website : ""]
  ].filter(p => p[1]);
  const nav = navItems.length
    ? '<div style="font:400 12px/1.9 ' + EMAIL_FONT + ';color:' + COLORS.muted + '">' + navItems.map(p =>
        '<a href="' + esc(p[1]) + '" style="color:' + COLORS.primary + ';text-decoration:none">' + esc(p[0]) + "</a>").join(' <span style="color:#C5CEDB">&middot;</span> ') + "</div>"
    : "";
  return '<tr><td bgcolor="#FFFFFF" class="pad" style="background:#FFFFFF;border-top:1px solid ' + COLORS.line + ';padding:20px 26px 24px">' +
    helpLine +
    '<div style="margin:10px 0 8px">' + nav + "</div>" +
    '<div style="font:400 11px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.faint + '">' + esc(legal || ("You are receiving this email because of your activity on " + brand.product + ".")) + "</div>" +
    '<div style="font:400 11px/1.7 ' + EMAIL_FONT + ";color:" + COLORS.faint + '>&copy; ' + new Date().getUTCFullYear() + " " + esc(brand.product) + "</div>" +
    "</td></tr>";
}`;

for (const target of paths) {
  let text = fs.readFileSync(target, 'utf8');
  const headerStart = text.indexOf('function brandHeader(brand, chip){');
  const headerEnd = text.indexOf('function brandFooter(brand, links, legal){');
  const footerStart = text.indexOf('function brandFooter(brand, links, legal){');
  const footerEnd = text.indexOf('function linkOf(links, key, fallback){');

  if (headerStart === -1 || headerEnd === -1 || footerStart === -1 || footerEnd === -1) {
    throw new Error(`Could not find template blocks in ${target}`);
  }

  text = text.slice(0, headerStart) + headerText + text.slice(headerEnd);
  const newFooterStart = text.indexOf('function brandFooter(brand, links, legal){');
  const newFooterEnd = text.indexOf('function linkOf(links, key, fallback){');
  text = text.slice(0, newFooterStart) + footerText + text.slice(newFooterEnd);

  fs.writeFileSync(target, text, 'utf8');
  console.log(`Updated ${path.relative(process.cwd(), target)}`);
}
