const fs = require('fs');
const src = fs.readFileSync('pdfkit.js', 'utf8');
const window = {};
eval(src);
const K = window.PdfKit;

function extractPdfText(pdfBytes) {
  const s = Buffer.from(pdfBytes).toString('latin1');
  const out = [];
  const re = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1].replace(/\\(.)/g, '$1'));
  return out.join(' ');
}

const html = '<p><strong>1.1</strong> This agreement appoints <em>Rembobwe Arts &amp; Events Kenya Ltd</em> (the “Organizer”) to sell event tickets through the Prince Alex TicketHub platform (the “Platform”).</p>';
const doc = new K.PdfDoc({ title: 'layout check' });
const blocks = K.parseHtmlBlocks(html, { size: 10, color: '1F2937' });
doc.html(blocks, { x: 48, width: 500 });
const pdf = Buffer.from(doc.build());
const text = extractPdfText(pdf);

const expected = [
  '1.1',
  'This agreement appoints',
  'Rembobwe Arts',
  'Events Kenya Ltd',
  'Organizer',
  'Prince Alex TicketHub platform',
  'Platform'
];

const missing = expected.filter((word) => text.indexOf(word) === -1);
if (missing.length) {
  console.error('MISSING:', missing.join(' | '));
  console.error('TEXT:', text);
  process.exit(1);
}
console.log('PASS');
