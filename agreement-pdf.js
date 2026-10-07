/* Shared browser-side organizer agreement PDF renderer. */
const PDF_C = {
  ink: "0B1220", body: "1F2937", muted: "5A6478", faint: "8A93A6", line: "E6E8F0",
  accent: "4F46E5", ok: "04674A", okFill: "E8F6EF", panel: "F7F8FC"
};
function pdfFeeRows(fee){
  const rows = Array.isArray(fee && fee.rows) ? fee.rows.filter(row => row &&
    (row.label != null || row.value != null || Array.isArray(row.cells))) : [];
  const config = (fee && fee.config) || {};
  const labels = {
    commission_percent: "Platform commission",
    commission_fixed: "Fixed platform fee",
    commission_basis: "Commission basis",
    payment_fees: "Payment processing fees",
    payout_terms: "Payout terms",
    refund_policy: "Refunds",
    cancellation_policy: "Cancellation",
    chargeback_policy: "Chargebacks and disputes",
    organizer_responsibilities: "Organizer responsibilities",
    tickethub_responsibilities: "TicketHub responsibilities",
    termination_conditions: "Termination",
    effective_note: "Notes"
  };
  const configRows = Object.keys(config).filter(key => config[key] != null && config[key] !== "")
    .map(key => ({ label: labels[key] || key, value: key === "commission_fixed" ? KES(config[key]) + " per order" : pdfSourceValue(config[key]) }));
  if(!rows.length) return configRows;
  const additionalConfigRows = configRows.filter(configRow => !rows.some(row =>
    String(row.label || "").trim().toLowerCase() === configRow.label.trim().toLowerCase() &&
    String(row.value == null ? "" : row.value).trim() === configRow.value.trim()));
  return rows.concat(additionalConfigRows);
}
function pdfSourceValue(value){
  if(typeof value === "string") return value;
  if(typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch(error){ return String(value); }
}
function pdfFormatListNumber(number, type){
  const value = Number(number);
  if(!Number.isFinite(value)) return String(number);
  if(type === "a" || type === "A"){
    if(value < 1) return String(number);
    let result = "";
    let current = Math.max(1, Math.floor(value));
    while(current > 0){ current--; result = String.fromCharCode(97 + current % 26) + result; current = Math.floor(current / 26); }
    return type === "A" ? result.toUpperCase() : result;
  }
  if(type === "i" || type === "I"){
    let current = Math.floor(value);
    if(current < 1 || current > 3999) return String(number);
    const numerals = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
    let result = "";
    numerals.forEach(pair => { while(current >= pair[0]){ result += pair[1]; current -= pair[0]; } });
    return type === "i" ? result.toLowerCase() : result;
  }
  return String(number);
}
function pdfListAttributeNumber(node, name, fallback){
  if(!node.hasAttribute(name)) return fallback;
  const value = parseInt(node.getAttribute(name), 10);
  return Number.isFinite(value) ? value : fallback;
}
function pdfAgreementBlocks(html){
  const raw = String(html || "");
  let source = raw;
  if(/&lt;\s*\/?\s*[a-z][\w:-]*(?:\s|&gt;|\/)/i.test(raw)){
    const decoder = document.createElement("textarea");
    decoder.innerHTML = raw;
    source = decoder.value;
  }
  const template = document.createElement("template");
  template.innerHTML = source;
  const blocks = [];
  const textOf = node => {
    if(node.nodeType === 3) return node.nodeValue || "";
    if(node.nodeType !== 1) return "";
    if(node.tagName === "BR") return "\n";
    if(node.tagName === "IMG") return "[Image: " + (node.getAttribute("alt") || node.getAttribute("title") || node.getAttribute("src") || "image") + "]";
    return Array.from(node.childNodes).map(textOf).join("");
  };
  const inlineRuns = (root, includeLists) => {
    const runs = [];
    const visit = (node, style) => {
      if(node.nodeType === 3){
        const rawText = String(node.nodeValue || "").replace(/\u00a0/g, " ");
        const text = style.pre ? rawText.replace(/\r\n?/g, "\n") : rawText.replace(/[\t\r\n ]+/g, " ");
        /* Skip pure whitespace between block elements so containers do not
           accumulate stray " " runs; real words are still kept verbatim. */
        if(!text) return;
        if(!style.pre && !text.trim()){
          const parentTag = node.parentElement && node.parentElement.tagName;
          if(runs.length && /^(A|B|STRONG|EM|I|U|S|DEL|CODE|SPAN|SMALL|SUB|SUP|MARK|P|LI|H[1-6])$/.test(parentTag || "")){
            const previous = runs[runs.length - 1];
            if(previous && !/\s$/.test(previous.text)) runs.push(Object.assign({ text: " " }, style));
          }
          return;
        }
        const previous = runs[runs.length - 1];
          const sameStyle = previous && ["bold", "italic", "underline", "strike", "code", "link", "mark", "small", "sup", "sub"].every(key => !!previous[key] === !!style[key]) && (previous.linkHref || "") === (style.linkHref || "");
          if(sameStyle) previous.text += text;
          else runs.push(Object.assign({ text: text }, style));
        return;
      }
      if(node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if(tag === "ul" || tag === "ol"){
        if(includeLists === false) return;
        const ordered = tag === "ol";
        const listItems = Array.from(node.children).filter(child => child.tagName && child.tagName.toLowerCase() === "li");
        const reversed = ordered && node.hasAttribute("reversed");
        let nextNumber = ordered ? pdfListAttributeNumber(node, "start", reversed ? listItems.length : 1) : 1;
        Array.from(node.children).forEach((li, index) => {
          if(li.tagName && li.tagName.toLowerCase() !== "li") visit(li, style);
          else {
            const itemNumber = ordered ? pdfListAttributeNumber(li, "value", nextNumber) : index + 1;
            const bullet = ordered ? pdfFormatListNumber(itemNumber, node.getAttribute("type")) + ". " : "\u2022 ";
            runs.push({ text: bullet, bold: false, italic: false, underline: false, strike: false, code: false, link: false });
            Array.from(li.childNodes).forEach(child => visit(child, style));
            runs.push({ text: "  ", bold: false, italic: false, underline: false, strike: false, code: false, link: false });
            if(ordered) nextNumber = itemNumber + (reversed ? -1 : 1);
          }
        });
        return;
      }
      if(tag === "br"){
        runs.push({ text: "\n", bold: false, italic: false, underline: false, strike: false, code: false, link: false });
        return;
      }
      if(tag === "img"){
        const description = node.getAttribute("alt") || node.getAttribute("title") || node.getAttribute("src") || "[Image]";
        runs.push(Object.assign({ text: "[Image: " + description + "]" }, style));
        return;
      }
      const css = String(node.getAttribute("style") || "").toLowerCase();
      const nextStyle = Object.assign({}, style, {
        bold: style.bold || tag === "b" || tag === "strong" || /font-weight\s*:\s*(bold|[6-9]00)/.test(css),
        italic: style.italic || tag === "i" || tag === "em" || /font-style\s*:\s*italic/.test(css),
        underline: style.underline || tag === "u" || /text-decoration[^;]*underline/.test(css),
        strike: style.strike || tag === "s" || tag === "del" || tag === "strike" || /text-decoration[^;]*(line-through|strike)/.test(css),
        code: style.code || tag === "code" || tag === "pre",
        mark: style.mark || tag === "mark",
        small: style.small || tag === "small",
        sup: style.sup || tag === "sup",
        sub: style.sub || tag === "sub",
        pre: style.pre || tag === "pre" || tag === "p",
        link: style.link || tag === "a",
        linkHref: tag === "a" ? (node.getAttribute("href") || "") : (style.linkHref || "")
      });
      const runCount = runs.length;
      Array.from(node.childNodes).forEach(child => visit(child, nextStyle));
      if(tag === "a" && runs.length === runCount && nextStyle.linkHref) runs.push(Object.assign({ text: nextStyle.linkHref }, nextStyle));
    };
    visit(root, { bold: false, italic: false, underline: false, strike: false, code: false, mark: false, small: false,
      sup: false, sub: false, pre: false, link: false });
    return runs;
  };
  const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/[\t\r ]+/g, " ").replace(/ *\n */g, "\n").trim();
  const isNumberedHeading = value => /^\d+(?:\.\d+)*[.)]?\s+\S/.test(value);
  const listDepth = node => {
    let depth = 0;
    let parent = node.parentElement;
    while(parent){
      if(parent.tagName === "UL" || parent.tagName === "OL") depth++;
      parent = parent.parentElement;
    }
    return Math.max(0, depth - 1);
  };
  const walkNestedLists = node => {
    Array.from(node.children || []).forEach(child => {
      const tag = child.tagName.toLowerCase();
      if(tag === "ul" || tag === "ol") walk(child);
      else walkNestedLists(child);
    });
  };
  const walk = node => {
    if(node.nodeType === 3){
      const text = clean(node.nodeValue);
      if(text) blocks.push({ type: "paragraph", text: text, runs: [{ text: text }] });
      return;
    }
    if(node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if(tag === "ul" || tag === "ol"){
      const listItems = Array.from(node.children).filter(child => child.tagName.toLowerCase() === "li");
      const ordered = tag === "ol";
      const reversed = ordered && node.hasAttribute("reversed");
      let nextNumber = ordered ? pdfListAttributeNumber(node, "start", reversed ? listItems.length : 1) : 1;
      listItems.forEach((item, index) => {
        const runs = inlineRuns(item, false);
        const text = clean(runs.map(run => run.text).join(""));
        const itemNumber = ordered ? pdfListAttributeNumber(item, "value", nextNumber) : index + 1;
        if(text) blocks.push({ type: "list", text: text, runs: runs, ordered: ordered, number: itemNumber,
          listType: ordered ? node.getAttribute("type") || "" : "", depth: listDepth(item) });
        if(ordered) nextNumber = itemNumber + (reversed ? -1 : 1);
        walkNestedLists(item);
      });
      return;
    }
    if(/^h[1-6]$/.test(tag)){
      const text = clean(textOf(node));
      if(text) blocks.push({ type: "heading", level: Number(tag.slice(1)), text: text,
        runs: inlineRuns(node), uppercase: tag === "h5" });
      return;
    }
    if(/^(a|code|del|em|i|mark|pre|s|small|span|strike|sub|sup|u)$/.test(tag)){
      const text = clean(textOf(node));
      if(text) blocks.push({ type: "paragraph", text: text, runs: inlineRuns(node) });
      return;
    }
    if(tag === "b" || tag === "strong"){
      const text = clean(textOf(node));
      if(isNumberedHeading(text)) blocks.push({ type: "heading", level: 3, text: text, runs: inlineRuns(node) });
      else if(text) blocks.push({ type: "paragraph", text: text, runs: inlineRuns(node) });
      return;
    }
    if(tag === "p" || tag === "blockquote"){
      const text = clean(textOf(node));
      const firstMeaningfulIndex = Array.from(node.childNodes).findIndex(child => child.nodeType !== 3 || (child.nodeValue || "").trim());
      const firstMeaningful = firstMeaningfulIndex >= 0 ? node.childNodes[firstMeaningfulIndex] : null;
      const leadingHeading = tag === "p" && firstMeaningful && firstMeaningful.nodeType === 1 &&
        /^(b|strong)$/i.test(firstMeaningful.tagName) && isNumberedHeading(clean(textOf(firstMeaningful)));
      if(leadingHeading){
        const headingText = clean(textOf(firstMeaningful));
        const remainder = document.createElement("div");
        Array.from(node.childNodes).forEach((child, index) => {
          if(index > firstMeaningfulIndex) remainder.appendChild(child.cloneNode(true));
        });
        blocks.push({ type: "heading", level: 3, text: headingText, runs: inlineRuns(firstMeaningful) });
        const remainderText = clean(textOf(remainder));
        if(remainderText) blocks.push({ type: "paragraph", text: remainderText, runs: inlineRuns(remainder) });
        return;
      }
      const boldHeading = tag === "p" && Array.from(node.children).length === 1 && /^(b|strong)$/i.test(node.children[0].tagName) && isNumberedHeading(text);
      const numberedHeading = tag === "p" && isNumberedHeading(text) && text.length < 100;
      let literalList = text.match(/^([-*]|\u2022)\s+/);
      if(!literalList && text.length >= 100) literalList = text.match(/^\d+[.)]\s+/);
      if(text && literalList){
        const isOrdered = /^\d/.test(literalList[0]);
        const remainder = node.cloneNode(true);
        let prefixLeft = literalList[0].length;
        const removePrefix = current => {
          Array.from(current.childNodes || []).some(child => {
            if(prefixLeft <= 0) return true;
            if(child.nodeType === 3){
              const removeCount = Math.min(prefixLeft, (child.nodeValue || "").length);
              child.nodeValue = (child.nodeValue || "").slice(removeCount);
              prefixLeft -= removeCount;
            } else if(child.nodeType === 1) removePrefix(child);
            return prefixLeft <= 0;
          });
        };
        removePrefix(remainder);
        const runs = inlineRuns(remainder);
        const listText = clean(runs.map(run => run.text).join(""));
        blocks.push({ type: "list", text: listText, runs: runs,
          ordered: isOrdered, number: isOrdered ? parseInt(literalList[0], 10) : 0, depth: 0 });
      } else if(text){
        blocks.push({ type: tag === "blockquote" ? "quote" : (boldHeading || numberedHeading ? "heading" : "paragraph"),
          level: boldHeading || numberedHeading ? 3 : null, text: text, runs: inlineRuns(node) });
      }
      return;
    }
    if(tag === "hr"){
      blocks.push({ type: "rule", text: "", runs: [] });
      return;
    }
    Array.from(node.childNodes).forEach(walk);
  };
  Array.from(template.content.childNodes).forEach(walk);
  /* A paragraph ending in ":" usually introduces a hand-typed list ("The
     Organizer agrees to:" followed by plain paragraphs). Only treat the
     following paragraphs as bullets when they actually look like items:
     every one must be short and NONE may read like a new narrative clause
     ("The Organizer is ...", "Either party may ...", "3. Payments ...").
     Otherwise ("agrees to:" + full agreement body) the old code swallowed
     the entire rest of the document into bullets drawn under one breath,
     and a single oversized bullet run could push the tail off the page. */
  const narrativeStart = /^(?:The Organizer|TicketHub|Ticket Hub|This Agreement|The Agreement|Either party|Each party|Where|Nothing in|Termination)\s+(?:is|are|remains|provides|will|may|does|should|can)\b/i;
  const numberedClauseStart = /^\d+(?:\.\d+)*[.)]?\s+\S/;
  for(let index = 0; index < blocks.length; index++){
    if(blocks[index].type !== "paragraph" || !/:\s*$/.test(blocks[index].text)) continue;
    const items = [];
    let stopped = false;
    for(let next = index + 1; next < blocks.length && blocks[next].type === "paragraph"; next++){
      const text = blocks[next].text || "";
      /* A real clause heading, numbered clause, quote-worthy sentence or a
         long narrative paragraph ends the introduced list. */
      if(narrativeStart.test(text) || numberedClauseStart.test(text) || text.length > 220){ stopped = true; break; }
      items.push(blocks[next]);
    }
    /* Keep genuine short intro lists; leave narrative bodies as paragraphs so
       each clause paginates on its own instead of merging into one bullet. */
    if(items.length < 2) continue;
    if(!stopped && items.some(item => (item.text || "").length > 140)) continue;
    items.forEach(item => {
      item.type = "list";
      item.ordered = false;
      item.number = 0;
      item.depth = 0;
    });
    index += items.length;
  }
  return blocks;
}
function pdfCommissionMismatch(feeRows, blocks){
  const schedule = feeRows.find(row => /commission/i.test(String(row.label || "")));
  const configured = schedule && String(schedule.value || "").match(/(\d+(?:\.\d+)?)\s*%/);
  if(!configured) return null;
  const configuredPercent = Number(configured[1]);
  const text = blocks.map(block => block.text).join(" ");
  const found = new Set();
  const pattern = /(?:platform\s+)?(?:commission|fee)[^.!?]{0,180}?\b(\d+(?:\.\d+)?)\s*%/gi;
  let match;
  while((match = pattern.exec(text)) !== null){
    const percent = Number(match[1]);
    if(Number.isFinite(percent) && percent !== configuredPercent) found.add(String(percent));
  }
  return found.size ? { schedule: String(configured[1]) + "%", clause: Array.from(found).join("%, ") + "%" } : null;
}
function pdfSignedSnapshot(html, context){
  const fallback = context || {};
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const main = parsed.querySelector("main");
  if(!main) throw new Error("The signed agreement document could not be read.");
  const cellText = cell => {
    let value = "";
    const visit = node => {
      if(node.nodeType === 3){ value += node.nodeValue || ""; return; }
      if(node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if(tag === "br"){ value += "\n"; return; }
      if(/^(p|div|section|article|li|blockquote|h[1-6]|tr)$/.test(tag) && value && !/\n$/.test(value)) value += "\n";
      if(tag === "img") value += "[Image: " + (node.getAttribute("alt") || node.getAttribute("title") || node.getAttribute("src") || "image") + "]";
      else Array.from(node.childNodes).forEach(visit);
      if(tag === "a"){
        const href = node.getAttribute("href") || "";
        if(href && !value.slice(-href.length).endsWith(href)) value += " (" + href + ")";
      }
      if(/^(p|div|section|article|li|blockquote|h[1-6]|tr)$/.test(tag) && !/\n$/.test(value)) value += "\n";
    };
    visit(cell);
    return value.replace(/\u00a0/g, " ").replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").trim();
  };
  const meta = {};
  const metadata = [];
  main.querySelectorAll("table.meta tr").forEach(row => {
    const cells = Array.from(row.children).filter(cell => /^(TH|TD)$/.test(cell.tagName));
    if(!cells.length) return;
    const labelCell = cells.find(cell => cell.tagName === "TH") || (cells.length > 1 ? cells[0] : null);
    const valueCells = labelCell ? cells.filter(cell => cell !== labelCell) : cells;
    const label = labelCell ? cellText(labelCell) : "";
    const value = valueCells.map(cellText).join(" | ");
    metadata.push({ label: label, value: value, cells: cells.map(cellText), cellsHtml: cells.map(cell => cell.innerHTML), html: row.outerHTML });
    if(label) meta[label] = value;
  });
  /* Heading wording drifts between versions ("Signatory ..." vs
     "Signatory (full legal name)"): match by prefix so the parties,
     reference and hash always resolve regardless of the exact label. */
  const metaValue = (...names) => {
    const keys = Object.keys(meta);
    for(const name of names){
      const hit = keys.find(key => key.toLowerCase().indexOf(String(name).toLowerCase()) === 0);
      if(hit) return meta[hit];
    }
    return "";
  };
  const feeRows = Array.from(main.querySelectorAll("table.fee tr")).map(row => {
    const cells = Array.from(row.children).filter(cell => /^(TH|TD)$/.test(cell.tagName));
    if(!cells.length) return { label: "", value: cellText(row), cells: [], cellsHtml: [], html: row.outerHTML };
    const labelCell = cells.find(cell => cell.tagName === "TH") || (cells.length > 1 ? cells[0] : null);
    const valueCells = labelCell ? cells.filter(cell => cell !== labelCell) : cells;
    return {
      label: labelCell ? cellText(labelCell) : "",
      value: valueCells.map(cellText).join(" | "),
      cells: cells.map(cellText),
      cellsHtml: cells.map(cell => cell.innerHTML),
      html: row.outerHTML
    };
  }).filter(Boolean);
  const termsHeading = Array.from(main.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).find(node => /agreement terms as accepted/i.test(node.textContent || ""));
  const documentNotes = Array.from(main.querySelectorAll(".note"));
  const note = termsHeading && documentNotes.find(node => (termsHeading.compareDocumentPosition(node) & 4) !== 0) || null;
  let content = "";
  if(termsHeading){
    const range = parsed.createRange();
    range.setStartAfter(termsHeading);
    if(note) range.setEndBefore(note);
    else range.setEnd(main, main.childNodes.length);
    const holder = parsed.createElement("div");
    holder.appendChild(range.cloneContents());
    content = holder.innerHTML;
  } else {
    const termsContainer = main.querySelector("[data-agreement-terms],.agreement-terms,.agreement-content,[class*='agreement-terms'],[class*='agreement-content']");
    if(termsContainer) content = termsContainer.innerHTML;
  }
  const sourceSha256 = metaValue("Document hash (SHA-256)", "Document hash", "SHA-256") || "";
  const reference = metaValue("Agreement reference", "Reference") || "";
  if(!reference || !/^[0-9a-f]{64}$/i.test(sourceSha256)){
    throw new Error("The signed source document is missing its reference or verification hash.");
  }
  const heading = main.querySelector("h1");
  const signatureMark = main.querySelector(".signature-mark img");
  const signatoryName = metaValue("Signatory (full legal name)", "Signatory", "Signatory name") || "";
  const signatoryEmail = metaValue("Signatory email", "Signatory e-mail", "Signer email") || (fallback.signature && fallback.signature.signatory_email) || "";
  const organizerName = metaValue("Organizer", "Organiser", "Business name") || (fallback.organizer && fallback.organizer.business_name) || "";
  const organizerEmail = metaValue("Organizer email", "Organizer e-mail", "Organiser email") || (fallback.organizer && fallback.organizer.email) || "";
  const additional = main.cloneNode(true);
  additional.querySelectorAll("table.meta,table.fee,.signature-mark,h1").forEach(node => node.remove());
  const additionalHeading = Array.from(additional.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"))
    .find(node => /agreement terms as accepted/i.test(node.textContent || ""));
  if(additionalHeading){
    const sourceHeading = termsHeading;
    const sourceNotes = sourceHeading && Array.from(main.querySelectorAll(".note"))
      .find(node => (sourceHeading.compareDocumentPosition(node) & 4) !== 0);
    const clonedNotes = sourceNotes ? Array.from(additional.querySelectorAll(".note")) : [];
    const clonedNote = sourceNotes ? clonedNotes.find(node => (additionalHeading.compareDocumentPosition(node) & 4) !== 0) : null;
    const range = parsed.createRange();
    range.setStartAfter(additionalHeading);
    if(clonedNote) range.setEndBefore(clonedNote);
    else range.setEnd(additional, additional.childNodes.length);
    range.deleteContents();
    additionalHeading.remove();
  } else {
    additional.querySelectorAll("[data-agreement-terms],.agreement-terms,.agreement-content,[class*='agreement-terms'],[class*='agreement-content']")
      .forEach(node => node.remove());
  }
  additional.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]").forEach(node => {
    if(/^(parties and record|organizer handwritten signature|platform fee terms accepted)$/i.test(node.textContent.trim())) node.remove();
  });
  Array.from(additional.querySelectorAll("div")).forEach(node => {
    if(node.classList.contains("note")) return;
    const versionLabel = Array.from(node.children).find(child => child.tagName === "STRONG" && /^version\b/i.test(child.textContent.trim()));
    const remainder = versionLabel ? node.textContent.slice(versionLabel.textContent.length).trim() : "";
    if(versionLabel && /^[·•]/.test(remainder)) node.remove();
  });
  additional.querySelectorAll("li").forEach(item => {
    const visibleText = item.textContent.replace(/[\s\u200b\u200c\u200d\ufeff]/g, "");
    if(!visibleText && !item.querySelector("img,svg,canvas")) item.remove();
  });
  additional.querySelectorAll("ul,ol").forEach(list => {
    if(!list.querySelector("li")) list.remove();
  });
  const additionalContent = additional.innerHTML;
  const representedMetadataLabels = [
    /^organizer(?:\/organiser)?(?: business)?(?: name)?$/i, /^organizer email$/i, /^organizer account(?: id)?$/i, /^organiser account(?: id)?$/i, /^account id$/i,
    /^signatory(?: \(full legal name\)| name)?$/i, /^signatory e-?mail$/i, /^signer e-?mail$/i, /^(capacity|role|signatory role)$/i,
    /^agreement reference$/i, /^reference$/i, /^version$/i, /^effective date$/i, /^signed at(?: \(utc\))?$/i, /^accepted at$/i,
    /^acceptance method$/i, /^verification method$/i, /^signature status$/i, /^status$/i, /^document hash(?: \(sha-?256\))?$/i, /^sha-?256$/i,
    /^agreement summary$/i, /^summary$/i, /^agreement title$/i, /^title$/i
  ];
  const consumedMetadata = new Set();
  representedMetadataLabels.forEach(pattern => {
    const found = metadata.findIndex((item, index) => !consumedMetadata.has(index) && pattern.test(item.label));
    if(found >= 0) consumedMetadata.add(found);
  });
  const additionalMetadata = metadata.filter((item, index) => !consumedMetadata.has(index));
  const sourceAttributes = [];
  Array.from(main.querySelectorAll("*")).forEach((node, index) => {
    Array.from(node.attributes || []).forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const isSemantic = name.indexOf("data-") === 0 || name === "title" || name === "aria-label" ||
        (node.tagName.toLowerCase() === "meta" && (name === "name" || name === "content")) ||
        (node.tagName.toLowerCase() === "input" && (name === "value" || name === "checked"));
      if(isSemantic && attribute.value !== "") sourceAttributes.push({
        label: "Source element " + (index + 1) + " (" + node.tagName.toLowerCase() + ")." + name,
        value: attribute.value
      });
    });
  });
  const signatureImageAlt = signatureMark ? (signatureMark.getAttribute("alt") || "") : "";
  const summary = metaValue("Agreement summary", "Summary") || "";
  const organizerId = metaValue("Organizer account ID", "Organizer ID", "Account ID") || (fallback.organizer && fallback.organizer.id) || null;
  return {
    agreement: {
      title: heading ? heading.textContent.trim() : "Organizer Agreement",
      version: metaValue("Version") || "-",
      effective_date: metaValue("Effective date", "Effective") || "",
      summary: summary
    },
    signature: {
      reference: reference,
      agreement_version: metaValue("Version") || "-",
      signatory_name: signatoryName,
      signatory_email: signatoryEmail,
      signatory_role: metaValue("Capacity", "Role", "Signatory role") || "",
      signature_image: signatureMark ? signatureMark.getAttribute("src") || "" : "",
      signature_image_alt: signatureImageAlt,
      accepted_at: metaValue("Signed at (UTC)", "Signed at", "Accepted at") || "",
      verification_method: metaValue("Acceptance method", "Verification method", "Acceptance") || "",
      status: metaValue("Signature status", "Status") || "accepted",
      document_ready: true
    },
    organizer: {
      id: organizerId,
      business_name: organizerName,
      email: organizerEmail
    },
    fee: {
      rows: feeRows,
      config: {},
      example: null,
      tableCaptions: Array.from(main.querySelectorAll("table.fee caption")).map(cellText)
    },
    metadata: metadata,
    additionalMetadata: additionalMetadata.concat(sourceAttributes),
    additionalContent: additionalContent,
    content: content,
    sourceSha256: sourceSha256
  };
}
function setPdfColor(doc, hex){
  const c = hexToRgbArray(hex || PDF_C.ink);
  doc.setTextColor(c[0], c[1], c[2]);
}
function hexToRgbArray(hex){
  const h = String(hex || "").replace(/^#/, "");
  if(!/^[0-9a-fA-F]{6}$/.test(h)) return [17, 19, 35];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function buildAgreementPdf(snapshot){
  const { jsPDF } = window.jspdf;
  const data = snapshot || {};
  const agreement = data.agreement || {};
  const signature = data.signature || {};
  const fee = data.fee || {};
  const organizer = data.organizer || {};
  const sourceSha256 = data.sourceSha256 || "";
  const version = agreement.version || "-";
  const reference = signature.reference || "Pending";
  const title = agreement.title || "Organizer Agreement";
  const signedAt = signature.accepted_at || "";
  const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 46;
  const bodyWidth = pageWidth - margin * 2;
  const bodyBottom = pageHeight - 58;
  const generatedAt = new Date().toISOString();
  let y = 0;

  pdf.setProperties({
    title: title + " - Signed Organizer Agreement",
    subject: "Signed agreement " + reference + " | source SHA-256 " + sourceSha256,
    author: BRAND.product
  });

  function drawHeader(firstPage){
    const headerHeight = firstPage ? 72 : 46;
    pdf.setFillColor(11, 18, 32);
    pdf.rect(0, 0, pageWidth, headerHeight, "F");
    pdf.setFillColor(79, 70, 229);
    pdf.roundedRect(margin, firstPage ? 19 : 10, 30, 28, 5, 5, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8.5);
    pdf.text("PAT", margin + 15, firstPage ? 37 : 28, { align: "center" });
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(firstPage ? 11.5 : 9.5);
    pdf.text(BRAND.product, margin + 40, firstPage ? 31 : 22);
    pdf.setTextColor(199, 207, 222);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.8);
    pdf.text(firstPage ? "SIGNED ORGANIZER AGREEMENT" : "Organizer agreement - continued", margin + 40, firstPage ? 47 : 35);
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8.5);
    pdf.text("VERSION " + version, pageWidth - margin, firstPage ? 27 : 20, { align: "right" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.8);
    pdf.text(reference, pageWidth - margin, firstPage ? 44 : 33, { align: "right" });
    y = firstPage ? 94 : 66;
  }

  function addPage(){
    pdf.addPage();
    drawHeader(false);
  }

  function ensureSpace(height){
    if(y + height > bodyBottom) addPage();
  }

  function textLines(text, font, style, size, width){
    pdf.setFont(font, style);
    pdf.setFontSize(size);
    return pdf.splitTextToSize(String(text == null ? "" : text), width);
  }

  function drawSection(label, heading){
    ensureSpace(44);
    setPdfColor(pdf, PDF_C.accent);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.5);
    pdf.text(label.toUpperCase(), margin, y);
    y += 17;
    setPdfColor(pdf, PDF_C.ink);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(13.5);
    pdf.text(heading, margin, y);
    y += 9;
    pdf.setDrawColor(224, 228, 236);
    pdf.setLineWidth(0.7);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 14;
  }

  function drawParagraph(text, options){
    const opts = options || {};
    const font = opts.serif ? "times" : "helvetica";
    const style = opts.fontStyle || (opts.bold ? "bold" : "normal");
    const size = opts.size || 9.5;
    const lineHeight = opts.lineHeight || size * 1.38;
    const indent = opts.indent || 0;
    const x = margin + indent;
    const lines = textLines(text, font, style, size, bodyWidth - indent);
    const after = opts.after == null ? 4 : opts.after;
    const paragraphHeight = lines.length * lineHeight + after;
    if(paragraphHeight <= bodyBottom - 66 && y + paragraphHeight > bodyBottom) addPage();
    lines.forEach(line => {
      if(y + lineHeight > bodyBottom) addPage();
      pdf.setFont(font, style);
      pdf.setFontSize(size);
      setPdfColor(pdf, opts.color || PDF_C.body);
      pdf.text(line, x, y);
      y += lineHeight;
    });
    y += after;
  }

  function drawRichParagraph(block, options){
    const opts = options || {};
    const runs = block.runs && block.runs.length ? block.runs : [{ text: block.text || "" }];
    const baseFont = opts.serif ? "times" : "helvetica";
    const size = opts.size || 10.1;
    const lineHeight = opts.lineHeight || size * 1.32;
    const indent = opts.indent || 0;
    const marker = opts.marker || "";
    const markerWidth = marker ? (marker === "bullet" ? 12 : 23) : 0;
    const startX = margin + indent + markerWidth;
    const maxWidth = bodyWidth - indent - markerWidth;
    const after = opts.after == null ? 4 : opts.after;
    const before = opts.before || 0;
    const runStyle = run => {
      const bold = !!(opts.bold || run.bold);
      const italic = opts.fontStyle === "italic" || !!run.italic;
      return bold ? (italic ? "bolditalic" : "bold") : (italic ? "italic" : "normal");
    };
    const runFont = run => run.code ? "courier" : baseFont;
    const runSize = run => Math.max(6, size * (run.sup || run.sub ? 0.72 : run.small ? 0.86 : run.code ? 0.9 : 1));
    const measure = (text, run) => {
      pdf.setFont(runFont(run), runStyle(run));
      pdf.setFontSize(runSize(run));
      return pdf.getTextWidth(text);
    };
    const lines = [];
    let currentLine = [];
    let currentWidth = 0;
    let pendingSpace = false;
    runs.forEach(run => {
      const runText = run.pre ? String(run.text || "").replace(/\t/g, "    ") : String(run.text || "").replace(/[\t\r ]+/g, " ");
      const parts = runText.match(run.pre ? /\n| +|[^\s]+/g : /\n|\s+|[^\s]+/g) || [];
      parts.forEach(part => {
        if(part === "\n"){
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
          pendingSpace = false;
          return;
        }
        if(/^\s+$/.test(part)){
          if(run.pre){
            Array.from(part).forEach(character => {
              const width = measure(character, run);
              if(currentLine.length && currentWidth + width > maxWidth){
                lines.push(currentLine);
                currentLine = [];
                currentWidth = 0;
              }
              currentLine.push({ run: run, text: character });
              currentWidth += width;
            });
          } else if(currentLine.length) pendingSpace = true;
          return;
        }
        let tokenParts = [part];
        if(measure(part, run) > maxWidth){
          tokenParts = [];
          let fragment = "";
          Array.from(part).forEach(character => {
            if(fragment && measure(fragment + character, run) > maxWidth){ tokenParts.push(fragment); fragment = ""; }
            fragment += character;
          });
          if(fragment) tokenParts.push(fragment);
        }
        tokenParts.forEach((token, tokenIndex) => {
          const gapWidth = currentLine.length && pendingSpace && tokenIndex === 0 ? measure(" ", run) : 0;
          const partWidth = measure(token, run);
          if(currentLine.length && currentWidth + gapWidth + partWidth > maxWidth){
            lines.push(currentLine);
            currentLine = [];
            currentWidth = 0;
          }
          if(currentLine.length && pendingSpace && tokenIndex === 0){
            currentLine.push({ run: run, text: " " });
            currentWidth += gapWidth;
          }
          currentLine.push({ run: run, text: token });
          currentWidth += partWidth;
          pendingSpace = false;
        });
      });
    });
    if(currentLine.length || !lines.length) lines.push(currentLine);
    const paragraphHeight = lines.length * lineHeight + before + after;
    if(y + paragraphHeight > bodyBottom) addPage();
    y += before;
    lines.forEach((line, lineIndex) => {
      if(y + lineHeight > bodyBottom) addPage();
      if(lineIndex === 0 && marker){
        if(marker === "bullet"){
          pdf.setFillColor(31, 41, 55);
          pdf.circle(margin + indent + 3, y - size * 0.3, 1.7, "F");
        } else {
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(size);
          setPdfColor(pdf, PDF_C.body);
          pdf.text(marker, margin + indent, y);
        }
      }
      let cursorX = startX;
      line.forEach(segment => {
        const run = segment.run;
        const font = runFont(run), style = runStyle(run);
        pdf.setFont(font, style);
        pdf.setFontSize(runSize(run));
        setPdfColor(pdf, run.link ? "1D4ED8" : (opts.color || PDF_C.body));
        const width = pdf.getTextWidth(segment.text);
        const segmentY = y + (run.sup ? -size * 0.3 : run.sub ? size * 0.2 : 0);
        if(run.mark){
          pdf.setFillColor(255, 243, 163);
          pdf.rect(cursorX, segmentY - runSize(run) * 0.78, width, runSize(run) * 1.05, "F");
        } else if(run.code){
          pdf.setFillColor(244, 244, 247);
          pdf.roundedRect(cursorX - 2, segmentY - runSize(run) * 0.8, width + 4, runSize(run) * 1.12, 2, 2, "F");
        }
        pdf.text(segment.text, cursorX, segmentY);
        if(run.underline || run.link){
          pdf.setDrawColor(run.link ? 29 : 31, run.link ? 78 : 41, run.link ? 216 : 55);
          pdf.setLineWidth(0.45);
          pdf.line(cursorX, segmentY + 1.5, cursorX + width, segmentY + 1.5);
        }
        if(run.link && run.linkHref && typeof pdf.link === "function") pdf.link(cursorX, segmentY - size, width, lineHeight, { url: run.linkHref });
        if(run.strike){
          pdf.setDrawColor(31, 41, 55);
          pdf.setLineWidth(0.45);
          pdf.line(cursorX, segmentY - runSize(run) * 0.3, cursorX + width, segmentY - runSize(run) * 0.3);
        }
        cursorX += width;
      });
      y += lineHeight;
    });
    y += after;
  }

  function drawListItem(block){
    const depth = Math.min(8, Math.max(0, Number(block.depth) || 0));
    const marker = block.ordered ? pdfFormatListNumber(block.number == null ? 1 : block.number, block.listType) + "." : "bullet";
    drawRichParagraph(block, { serif: true, size: 10.5, lineHeight: 13, color: "111111",
      indent: depth * 14, marker: marker, after: 4.5 });
  }

  function drawAgreementContentBlock(block){
    if(block.type === "rule"){
      ensureSpace(27);
      y += 13.5;
      pdf.setDrawColor(221, 221, 221);
      pdf.setLineWidth(0.6);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 13.5;
      return;
    }
    if(block.type === "heading"){
      const level = Math.max(3, Math.min(5, Number(block.level) || 3));
      const headingStyle = level === 3 ? { size: 12, before: 16.5, after: 6 } :
        (level === 4 ? { size: 10.875, before: 13.5, after: 4.5 } : { size: 10.125, before: 10.5, after: 4.5 });
      const headingBlock = block.uppercase ? Object.assign({}, block, {
        text: String(block.text || "").toUpperCase(),
        runs: (block.runs || []).map(run => Object.assign({}, run, { text: String(run.text || "").toUpperCase() }))
      }) : block;
      drawRichParagraph(headingBlock, { size: headingStyle.size, bold: true, serif: true, color: "111111",
        before: headingStyle.before, after: headingStyle.after, lineHeight: headingStyle.size * 1.2 });
    } else if(block.type === "list") drawListItem(block);
    else if(block.type === "quote") drawRichParagraph(block, { size: 10.5, serif: true, fontStyle: "italic",
      indent: 14, color: "333333", after: 9, lineHeight: 13 });
    else drawRichParagraph(block, { size: 10.5, serif: true, color: "111111", after: 7.5, lineHeight: 13 });
  }

  function drawRecordGrid(rows){
    const gap = 18;
    const columnWidth = (bodyWidth - gap) / 2;
    for(let index = 0; index < rows.length; index += 2){
      const left = rows[index];
      const right = rows[index + 1] || null;
      const cells = [left, right].map((row, cellIndex) => {
        if(!row) return { row: null, x: margin + cellIndex * (columnWidth + gap), lines: [] };
        const x = margin + cellIndex * (columnWidth + gap);
        const valueLines = textLines(row[1], "helvetica", "normal", 8.8, columnWidth - 16);
        const labelLines = textLines(row[0], "helvetica", "bold", 7.2, columnWidth - 16);
        return { row: row, x: x, lines: labelLines.map(text => ({ text: text, label: true }))
          .concat(valueLines.map(text => ({ text: text, label: false }))) };
      });
      const totalLines = Math.max(cells[0].lines.length, cells[1].lines.length);
      let offset = 0;
      while(offset < totalLines){
        if(bodyBottom - y < 24) addPage();
        const linesOnPage = Math.max(1, Math.floor((bodyBottom - y - 8) / 11));
        const stop = Math.min(totalLines, offset + linesOnPage);
        const fragmentHeight = (stop - offset) * 11 + 8;
        if((index / 2) % 2 === 0){
          pdf.setFillColor(248, 249, 252);
          pdf.rect(margin, y, bodyWidth, fragmentHeight, "F");
        }
        cells.forEach(cell => cell.lines.slice(offset, stop).forEach((line, lineIndex) => {
          setPdfColor(pdf, line.label ? PDF_C.muted : PDF_C.body);
          pdf.setFont("helvetica", line.label ? "bold" : "normal");
          pdf.setFontSize(line.label ? 7.2 : 8.8);
          pdf.text(line.text, cell.x + 8, y + 10 + lineIndex * 11);
        }));
        y += fragmentHeight;
        offset = stop;
        pdf.setDrawColor(231, 234, 240);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y, pageWidth - margin, y);
        y += 3;
        if(offset < totalLines) addPage();
      }
    }
    y += 5;
  }

  function drawFeeRows(rows){
    const labelWidth = 138;
    rows.forEach((row, index) => {
      const label = String(row.label == null ? "" : row.label);
      const value = row.value == null ? "" : String(row.value);
      const valueLines = textLines(value, "helvetica", "normal", 9, bodyWidth - labelWidth - 18);
      const labelLines = textLines(label, "helvetica", "bold", 8.2, labelWidth - 12);
      const rowHeight = Math.max(19 + valueLines.length * 11.5, 12 + labelLines.length * 10);
      const availableHeight = bodyBottom - y;
      if(rowHeight <= availableHeight) ensureSpace(rowHeight);
      setPdfColor(pdf, PDF_C.muted);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8.2);
      const labelLineHeight = 10;
      const valueLineHeight = 11.5;
      let lineIndex = 0;
      let firstPage = true;
      while(lineIndex < Math.max(valueLines.length, labelLines.length, 1)){
        const room = bodyBottom - y;
        if(room < 20) addPage();
        const linesOnPage = Math.max(1, Math.floor((bodyBottom - y - 4) / valueLineHeight));
        const stop = Math.min(Math.max(valueLines.length, labelLines.length, 1), lineIndex + linesOnPage);
        const fragmentHeight = (stop - lineIndex) * valueLineHeight + (firstPage ? 14 : 5);
        if(index % 2 === 0){
          pdf.setFillColor(248, 249, 252);
          pdf.rect(margin, y, bodyWidth, fragmentHeight, "F");
        }
        labelLines.slice(lineIndex, stop).forEach((line, offset) => pdf.text(line, margin + 8, y + 12 + offset * labelLineHeight));
        setPdfColor(pdf, PDF_C.body);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        valueLines.slice(lineIndex, stop).forEach((line, offset) => pdf.text(line, margin + labelWidth, y + 12 + offset * valueLineHeight));
        y += fragmentHeight;
        lineIndex = stop;
        firstPage = false;
        if(lineIndex < Math.max(valueLines.length, labelLines.length, 1)) addPage();
      }
      y += 3;
    });
    y += 5;
  }

  function drawAdditionalInformation(rows, html){
    const blocks = pdfAgreementBlocks(html || "");
    const metadataRows = Array.isArray(rows) ? rows : [];
    if(!blocks.length && !metadataRows.length) return;
    drawSection("03A / ADDITIONAL AGREEMENT INFORMATION", "Additional Agreement Information");
    metadataRows.forEach(row => {
      const label = String(row.label == null ? "" : row.label);
      const value = String(row.value == null ? "" : row.value);
      if(label) drawRichParagraph({ runs: [{ text: label, bold: true }] }, { size: 9.2, serif: true, after: 1, lineHeight: 12.5 });
      const cellsHtml = Array.isArray(row.cellsHtml) ? row.cellsHtml.slice(1) : [];
      const valueBlocks = cellsHtml.length ? pdfAgreementBlocks(cellsHtml.map(cell => "<span>" + cell + "</span>").join("<span> | </span>")) : [];
      if(valueBlocks.length){
        valueBlocks.forEach(block => drawRichParagraph(block, { size: 9.2, serif: true, indent: label ? 8 : 0, after: 3, lineHeight: 12.5 }));
      } else {
        drawRichParagraph({ runs: [{ text: label ? ": " : "" }, { text: value }] },
          { size: 9.2, serif: true, indent: label ? 8 : 0, after: 5, lineHeight: 12.5 });
      }
    });
    blocks.forEach(drawAgreementContentBlock);
  }

  function drawSignatureImage(cardY){
    setPdfColor(pdf, PDF_C.muted);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.5);
    pdf.text("ELECTRONICALLY ACCEPTED BY", margin + 13, cardY + 16);
    if(signature.signature_image){
      const src = String(signature.signature_image || "");
      const imageFormat = /^data:image\/jpeg/i.test(src) || /^data:image\/jpg/i.test(src) ? "JPEG" : "PNG";
      try {
        pdf.addImage(src, imageFormat, margin + 13, cardY + 23, 190, 41);
      } catch(imageError){
        pdf.setFont("helvetica", "italic");
        pdf.setFontSize(8.2);
        pdf.text("Handwritten signature image could not be embedded in this copy.", margin + 13, cardY + 47);
      }
    } else {
      pdf.setFont("helvetica", "italic");
      pdf.setFontSize(8.2);
      pdf.text("No handwritten signature image is present in the signed source document.", margin + 13, cardY + 47);
    }
  }

  drawHeader(true);
  setPdfColor(pdf, PDF_C.accent);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  pdf.text("EXECUTED AGREEMENT", margin, y);
  y += 19;
  const titleLines = textLines(title, "helvetica", "bold", 19, bodyWidth);
  titleLines.forEach(line => { pdf.setTextColor(11, 18, 32); pdf.setFont("helvetica", "bold"); pdf.setFontSize(19); pdf.text(line, margin, y); y += 22; });
  y += 2;
  pdf.setFillColor(232, 246, 239);
  pdf.roundedRect(margin, y, 104, 18, 4, 4, "F");
  setPdfColor(pdf, PDF_C.ok);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.7);
  pdf.text("SIGNED AND ACCEPTED", margin + 8, y + 12);
  y += 26;

  const metaBits = [];
  if(version !== "-") metaBits.push("Version " + version);
  if(agreement.effective_date) metaBits.push("Effective " + fmtWallDate(agreement.effective_date));
  if(signedAt) metaBits.push("Accepted (UTC) " + signedAt);
  if(metaBits.length) drawParagraph(metaBits.join("   |   "), { size: 8.2, color: PDF_C.muted, after: 9 });
  if(agreement.summary) drawParagraph(agreement.summary, { size: 8.8, color: PDF_C.muted, after: 8 });

  drawSection("01 / SIGNING RECORD", "Parties and acceptance record");
  drawRecordGrid([
    ["Organizer account ID", organizer.id || "Not recorded"],
    ["Organizer", organizer.business_name || "-"],
    ["Organizer email", organizer.email || "-"],
    ["Signatory (full legal name)", signature.signatory_name || "-"],
    ["Signatory email", signature.signatory_email || "-"],
    ["Capacity", signature.signatory_role || "Not recorded"],
    ["Agreement reference", reference],
    ["Version", signature.agreement_version || version],
    ["Effective date", agreement.effective_date || "Not recorded"],
    ["Signed at (UTC)", signedAt || "Not recorded"],
    ["Acceptance method", signature.verification_method || "Not recorded"],
    ["Signature status", signature.status || "Not recorded"],
    ["Source signed document", signature.document_ready ? "Available" : "Not recorded"]
  ]);

  const feeRows = pdfFeeRows(fee);
  const agreementBlocks = pdfAgreementBlocks(data.content || "");
  const feeMismatch = pdfCommissionMismatch(feeRows, agreementBlocks);
  const warning = feeMismatch
    ? "The fee schedule records " + feeMismatch.schedule + ", while the agreement text states " + feeMismatch.clause + ". Both values are reproduced as stored. Confirm the controlling fee term; this PDF does not resolve the inconsistency."
    : "";
  const warningLines = warning ? textLines(warning, "helvetica", "normal", 8.4, bodyWidth - 26) : [];
  const example = fee.example && typeof fee.example === "object" ? fee.example : null;
  const exampleKeys = example ? Object.keys(example) : [];
  const standardExampleKeys = ["base_amount", "platform_fee", "organizer_net", "commission_percent", "fixed_fee"];
  const hasStandardExample = exampleKeys.some(key => standardExampleKeys.indexOf(key) >= 0);
  const additionalExampleRows = exampleKeys.filter(key => standardExampleKeys.indexOf(key) < 0)
    .map(key => ({ label: key, value: pdfSourceValue(example[key]) }));
  let feeSectionHeight = 48 + (feeRows.length ? 0 : 48) + (warning ? 35 + warningLines.length * 11 : 0);
  feeRows.forEach(row => {
    const valueLines = textLines(row.value == null ? "" : row.value, "helvetica", "normal", 9, bodyWidth - 156);
    feeSectionHeight += 19 + valueLines.length * 11.5;
  });
  if(hasStandardExample) feeSectionHeight += 62;
  additionalExampleRows.forEach(row => {
    const valueLines = textLines(row.value, "helvetica", "normal", 9, bodyWidth - 156);
    feeSectionHeight += 19 + valueLines.length * 11.5;
  });
  ensureSpace(feeSectionHeight);
  drawSection("02 / FEE SCHEDULE", "Platform fee terms accepted");
  if(feeRows.length) drawFeeRows(feeRows);
  else drawParagraph("No fee schedule rows were present in the signed source document.", { size: 8.8, color: PDF_C.muted });
  (Array.isArray(fee.tableCaptions) ? fee.tableCaptions : []).forEach(caption => {
    drawParagraph(caption, { size: 8.5, color: PDF_C.muted, after: 4 });
  });
  if(warning){
    const warningHeight = 30 + warningLines.length * 11;
    ensureSpace(warningHeight);
    pdf.setFillColor(255, 248, 235);
    pdf.roundedRect(margin, y, bodyWidth, warningHeight, 4, 4, "F");
    pdf.setFillColor(180, 83, 9);
    pdf.rect(margin, y, 3, warningHeight, "F");
    setPdfColor(pdf, "92400E");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.8);
    pdf.text("FEE TERM CONFLICT - REVIEW REQUIRED", margin + 11, y + 13);
    setPdfColor(pdf, PDF_C.body);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.4);
    warningLines.forEach((line, lineIndex) => pdf.text(line, margin + 11, y + 25 + lineIndex * 11));
    y += warningHeight + 8;
  }
  if(hasStandardExample){
    const exampleParts = [];
    ["base_amount", "platform_fee", "organizer_net", "commission_percent", "fixed_fee"].forEach(key => {
      if(!Object.prototype.hasOwnProperty.call(example, key)) return;
      const labels = { base_amount: "Order amount", platform_fee: "Platform fee", organizer_net: "Organizer receives",
        commission_percent: "Commission percentage", fixed_fee: "Fixed fee" };
      const value = ["base_amount", "platform_fee", "organizer_net", "fixed_fee"].indexOf(key) >= 0 ? KES(example[key]) : pdfSourceValue(example[key]);
      exampleParts.push(labels[key] + ": " + value);
    });
    const exampleText = exampleParts.join("  |  ");
    const exampleLines = textLines(exampleText, "helvetica", "normal", 8.5, bodyWidth - 20);
    const exampleHeight = Math.max(48, 26 + exampleLines.length * 11);
    ensureSpace(exampleHeight + 10);
    pdf.setFillColor(248, 249, 252);
    pdf.roundedRect(margin, y, bodyWidth, exampleHeight, 4, 4, "F");
    setPdfColor(pdf, PDF_C.muted);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.5);
    pdf.text("ILLUSTRATIVE FEE EXAMPLE", margin + 10, y + 14);
    setPdfColor(pdf, PDF_C.body);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.5);
    exampleLines.forEach((line, lineIndex) => pdf.text(line, margin + 10, y + 30 + lineIndex * 11));
    y += exampleHeight + 8;
  }
  if(additionalExampleRows.length){
    drawParagraph("Additional illustrative fee fields", { size: 8.2, color: PDF_C.muted, after: 3 });
    drawFeeRows(additionalExampleRows);
  }

  drawSection("03 / AGREEMENT TEXT", "Terms as accepted");
  if(agreementBlocks.length){
    agreementBlocks.forEach(drawAgreementContentBlock);
  } else drawParagraph("The agreement text is not available for this version.", { size: 8.8, color: PDF_C.muted });

  drawAdditionalInformation(data.additionalMetadata, data.additionalContent);

  const signerName = signature.signatory_name || "";
  const signerContact = [signature.signatory_role, signature.signatory_email || organizer.email].filter(Boolean).join("  |  ");
  const executionRecord = "Accepted (UTC): " + (signedAt || "Not recorded") + "    |    Agreement reference: " + reference;
  const signerNameLines = signerName ? textLines(signerName, "helvetica", "bold", 13, bodyWidth - 28) : [];
  const signerContactLines = signerContact ? textLines(signerContact, "helvetica", "normal", 9, bodyWidth - 28) : [];
  const executionRecordLines = textLines(executionRecord, "helvetica", "normal", 7.8, bodyWidth - 28);
  const signatureCardHeight = 82 + signerNameLines.length * 15 + (signerContactLines.length ? 3 + signerContactLines.length * 12 : 0) +
    6 + 13 + executionRecordLines.length * 10.5 + 12;
  const cardFitsPage = signatureCardHeight + 44 <= bodyBottom - 66;
  ensureSpace(cardFitsPage ? signatureCardHeight + 48 : 132);
  drawSection("04 / EXECUTION", "Organizer signature");
  const cardHeight = cardFitsPage ? signatureCardHeight : 78;
  pdf.setFillColor(248, 249, 252);
  pdf.roundedRect(margin, y, bodyWidth, cardHeight, 5, 5, "F");
  pdf.setDrawColor(224, 228, 236);
  pdf.roundedRect(margin, y, bodyWidth, cardHeight, 5, 5, "S");
  const cardY = y;
  drawSignatureImage(cardY);
  if(cardFitsPage){
    let signerY = cardY + 82;
    if(signerNameLines.length){
      setPdfColor(pdf, PDF_C.ink);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(13);
      signerNameLines.forEach(line => { pdf.text(line, margin + 13, signerY); signerY += 15; });
    }
    if(signerContactLines.length){
      signerY += signerNameLines.length ? 3 : 0;
      setPdfColor(pdf, PDF_C.body);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      signerContactLines.forEach(line => { pdf.text(line, margin + 13, signerY); signerY += 12; });
    }
    signerY += 6;
    pdf.setDrawColor(220, 224, 232);
    pdf.line(margin + 13, signerY, pageWidth - margin - 13, signerY);
    signerY += 13;
    setPdfColor(pdf, PDF_C.muted);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.8);
    executionRecordLines.forEach(line => { pdf.text(line, margin + 13, signerY); signerY += 10.5; });
    y = cardY + cardHeight + 13;
  } else {
    y = cardY + cardHeight + 18;
    if(signerName) drawParagraph(signerName, { bold: true, size: 13, after: 4, lineHeight: 17 });
    if(signerContact) drawParagraph(signerContact, { size: 9, after: 6, lineHeight: 12 });
    drawParagraph(executionRecord, { size: 7.8, color: PDF_C.muted, after: 8, lineHeight: 10.5 });
  }

  drawSection("05 / SOURCE VERIFICATION", "Verification and document status");
  drawRecordGrid([
    ["Authoritative source", "Worker-stored signed HTML document"],
    ["PDF generated (UTC)", generatedAt],
    ["Source SHA-256", sourceSha256 || "Not available"]
  ]);
  drawParagraph("This PDF is a presentation copy derived from the authenticated signed source document. The SHA-256 value above identifies that HTML source, not this PDF. The PDF itself is not digitally signed.", { size: 8, color: PDF_C.muted, after: 0, lineHeight: 10.5 });

  const totalPages = pdf.getNumberOfPages();
  for(let pageNumber = 1; pageNumber <= totalPages; pageNumber++){
    pdf.setPage(pageNumber);
    pdf.setDrawColor(224, 228, 236);
    pdf.setLineWidth(0.6);
    pdf.line(margin, pageHeight - 38, pageWidth - margin, pageHeight - 38);
    setPdfColor(pdf, PDF_C.muted);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.2);
    pdf.text(BRAND.product + "  |  Signed agreement", margin, pageHeight - 22);
    pdf.text("Page " + pageNumber + " of " + totalPages, pageWidth / 2, pageHeight - 22, { align: "center" });
    pdf.text(reference, pageWidth - margin, pageHeight - 22, { align: "right" });
  }
  return pdf;
}
window.AgreementPdf = { pdfSignedSnapshot, buildAgreementPdf };
