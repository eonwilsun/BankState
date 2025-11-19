/*
  Client-side PDF parsing and export logic.
  - Uses PDF.js to extract text items grouped by Y coordinate (line reconstruction)
  - Parses lines to identify transactions (date at line start)
  - Builds rows: date, paymentType, details1, details2, paidIn, paidOut, balance
  - Exports CSV, XLSX (SheetJS), and XML
*/

const statusEl = document.getElementById('status');
const fileInput = document.getElementById('file');
const parseBtn = document.getElementById('parseBtn');
const preview = document.getElementById('preview');
const downloadCsv = document.getElementById('downloadCsv');
const downloadXlsx = document.getElementById('downloadXlsx');
const downloadXml = document.getElementById('downloadXml');

let parsedRows = [];

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';

parseBtn.addEventListener('click', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return (statusEl.textContent = 'Please select a PDF file first.');
  statusEl.textContent = 'Reading PDF...';
  parsedRows = [];
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data:arrayBuffer}).promise;

    statusEl.textContent = 'Parsing PDF (column-aware)...';
    parsedRows = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const text = await page.getTextContent();
      const pageRows = parsePageItemsToRows(text.items);
      parsedRows = parsedRows.concat(pageRows);
    }

    // Fallback: if nothing found, fall back to the original line-based parser
    if (parsedRows.length === 0) {
      statusEl.textContent = 'Falling back to line-based parsing...';
      let fullLines = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const text = await page.getTextContent();
        const map = new Map();
        text.items.forEach(item => {
          const y = Math.round(item.transform[5]);
          const existing = map.get(y) || [];
          existing.push({x: item.transform[4], str: item.str});
          map.set(y, existing);
        });
        const ys = Array.from(map.keys()).sort((a,b)=>b-a);
        ys.forEach(y=>{
          const items = map.get(y).sort((a,b)=>a.x-b.x);
          const line = items.map(i=>i.str).join(' ').trim();
          if (line) fullLines.push(line);
        });
      }
      parsedRows = parseLinesToTransactions(fullLines);
    }
    statusEl.textContent = `Parsed ${parsedRows.length} transactions.`;
    renderPreview(parsedRows);
    downloadCsv.disabled = downloadXlsx.disabled = downloadXml.disabled = parsedRows.length === 0;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error reading PDF: see console.';
  }
});

function parseLinesToTransactions(lines) {
  const rows = [];
  const dateRegex = /^\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})\b/; // e.g., 19 Oct 22
  const carryForwardRegex = /BALANCE\s+(BROUGHT|CARRIED)\s+FORWARD/i;
  const moneyRegex = /\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2}/g;

  let currentDate = null;
  let lastTransaction = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx].trim();
    if (!raw) continue;

    const dmatch = raw.match(dateRegex);
    // helper to detect obvious header/footer lines
    function isHeaderText(s) {
      if (!s) return false;
      const ss = s.toLowerCase();
      if (ss.includes('payment type') || ss.includes('your bank account') || ss.includes('balance brought') || ss.includes('balance carried') || ss.includes('account name')) return true;
      return false;
    }

    if (date) {
      // Line contains a date — treat as a new transaction starting point
      currentDate = dmatch[1];
      // skip header/footer rows that sometimes have date-like text but aren't transactions
      if (!isHeaderText(t.details1) && !(t.details1 === '' && t.paidOut === '' && t.paidIn === '' && t.balance === '')) {
        out.push(t);
        lastRowObj = t;
      }
      const paymentType = (rest.match(/^([A-Z]{1,5})\b/) || [])[1] || '';
      let moneyFound = (raw.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));

      const details = [];
      let firstDetail = rest.replace(/^([A-Z]{1,5})\b/, '').trim();
      firstDetail = firstDetail.replace(moneyRegex, '').trim();
      if (firstDetail) details.push(firstDetail);

      // look ahead to collect following non-date lines that look like part of this transaction
      let j = idx + 1;
      while (j < lines.length) {
        const nxt = lines[j].trim();
        if (!nxt) { j++; continue; }
        if (dateRegex.test(nxt)) break; // next transaction with explicit date
        // if the next line appears to be another transaction (contains money or starts with payment type), stop collecting here
        const startsWithPayment = !!nxt.match(/^([A-Z]{1,5})\b/);
        const hasMoney = !!nxt.match(moneyRegex);
        if (startsWithPayment || hasMoney) break;
        // otherwise treat as continuation detail
        details.push(nxt);
        j++;
      }

      // Extract trailing amounts from last detail if present
      if (details.length > 0) {
        const lastIdx = details.length - 1;
        const last = details[lastIdx];
        const tailMatch = last.match(/((?:\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*){1,3})\s*$/);
        if (tailMatch) {
          const tail = tailMatch[1].trim();
          const tailAmounts = (tail.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));
          details[lastIdx] = last.slice(0, last.lastIndexOf(tail)).trim();
          moneyFound = moneyFound.concat(tailAmounts);
        }
      }

      // Map amounts
      let paidOut = '';
      let paidIn = '';
      let balance = '';
      if (moneyFound.length >= 3) {
        paidOut = moneyFound[0];
        paidIn = moneyFound[1];
        balance = moneyFound[2];
      } else if (moneyFound.length === 2) {
        paidOut = moneyFound[0];
        balance = moneyFound[1];
      } else if (moneyFound.length === 1) {
        if (paymentType === 'CR') paidIn = moneyFound[0]; else paidOut = moneyFound[0];
      }

      const t = {
        date: currentDate,
        paymentType,
        details1: details[0] || '',
        details2: details[1] || '',
        paidIn: paidIn || '',
        paidOut: paidOut || '',
        balance: balance || ''
      };
      rows.push(t);
      lastTransaction = t;
      // advance idx to j-1
      idx = j - 1;
      continue;
    }

    // No date on this line. If we have a currentDate, this line may start a new transaction (e.g., 'VIS ...' on the next line)
    if (currentDate) {
      const startsWithPayment = !!raw.match(/^([A-Z]{1,5})\b/);
      const hasMoney = !!raw.match(moneyRegex);
      if (startsWithPayment || hasMoney) {
        // treat as a new transaction on the same date
        const rest = raw;
        const paymentType = (rest.match(/^([A-Z]{1,5})\b/) || [])[1] || '';
        let moneyFound = (rest.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));
        const details = [];
        let firstDetail = rest.replace(/^([A-Z]{1,5})\b/, '').trim();
        firstDetail = firstDetail.replace(moneyRegex, '').trim();
        if (firstDetail) details.push(firstDetail);

        // look ahead for continuation lines that are not dates and not starting new transactions
        let j = idx + 1;
        while (j < lines.length) {
          const nxt = lines[j].trim();
          if (!nxt) { j++; continue; }
          if (dateRegex.test(nxt)) break;
          const nxtStartsWithPayment = !!nxt.match(/^([A-Z]{1,5})\b/);
          const nxtHasMoney = !!nxt.match(moneyRegex);
          if (nxtStartsWithPayment || nxtHasMoney) break;
          details.push(nxt);
          j++;
        }

        // Extract trailing amounts from last detail
        if (details.length > 0) {
          const lastIdx = details.length - 1;
          const last = details[lastIdx];
          const tailMatch = last.match(/((?:\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*){1,3})\s*$/);
          if (tailMatch) {
            const tail = tailMatch[1].trim();
            const tailAmounts = (tail.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));
            details[lastIdx] = last.slice(0, last.lastIndexOf(tail)).trim();
            moneyFound = moneyFound.concat(tailAmounts);
          }
        }

        let paidOut = '';
        let paidIn = '';
        let balance = '';
        if (moneyFound.length >= 3) {
          paidOut = moneyFound[0];
          paidIn = moneyFound[1];
          balance = moneyFound[2];
        } else if (moneyFound.length === 2) {
          paidOut = moneyFound[0];
          balance = moneyFound[1];
        } else if (moneyFound.length === 1) {
          if (paymentType === 'CR') paidIn = moneyFound[0]; else paidOut = moneyFound[0];
        }

        const t = {
          date: currentDate,
          paymentType,
          details1: details[0] || '',
          details2: details[1] || '',
          paidIn: paidIn || '',
          paidOut: paidOut || '',
          balance: balance || ''
        };
        rows.push(t);
        lastTransaction = t;
        idx = j - 1;
        continue;
      }

      // Otherwise treat this line as continuation of the last transaction's details
      if (lastTransaction) {
        if (!lastTransaction.details2) lastTransaction.details2 = raw;
        else lastTransaction.details2 += ' ' + raw;
      }
    }
  }
  return rows;
}

// Column-aware parsing using PDF.js text item x positions.
function parsePageItemsToRows(items) {
  const moneyRegex = /\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2}/g;
  // normalize items: x and y
  const norm = items.map(it => ({x: it.transform[4], y: Math.round(it.transform[5]), str: it.str}));
  // group by y
  const ymap = new Map();
  norm.forEach(it => {
    const arr = ymap.get(it.y) || [];
    arr.push(it);
    ymap.set(it.y, arr);
  });
  const ys = Array.from(ymap.keys()).sort((a,b)=>b-a);
  const rows = ys.map(y => {
    const rowItems = ymap.get(y).sort((a,b)=>a.x-b.x);
    return {y, items: rowItems};
  });

  // detect money column x positions
  const moneyXs = [];
  norm.forEach(it => {
    if (it.str && it.str.match(moneyRegex)) moneyXs.push(Math.round(it.x));
  });
  const uniqMoneyXs = Array.from(new Set(moneyXs)).sort((a,b)=>a-b);

  // detect header keywords if present
  const headerMap = {};
  norm.forEach(it => {
    const s = (it.str||'').toLowerCase();
    if (s.includes('date')) headerMap.date = it.x;
    if (s.includes('paid out')) headerMap.paidOut = it.x;
    if (s.includes('paid in')) headerMap.paidIn = it.x;
    if (s.includes('balance')) headerMap.balance = it.x;
  });

  // assign money column xs: prefer headers, else use uniqMoneyXs
  let paidOutX, paidInX, balanceX;
  if (headerMap.paidOut) paidOutX = headerMap.paidOut;
  if (headerMap.paidIn) paidInX = headerMap.paidIn;
  if (headerMap.balance) balanceX = headerMap.balance;
  if (!balanceX && uniqMoneyXs.length) balanceX = uniqMoneyXs[uniqMoneyXs.length-1];
  if (!paidInX && uniqMoneyXs.length>=3) paidInX = uniqMoneyXs[uniqMoneyXs.length-2];
  if (!paidOutX && uniqMoneyXs.length>=2) paidOutX = uniqMoneyXs[0];

  // dateX is leftmost text that matches a date pattern or minimal x
  const datePattern = /^\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\b/;
  let dateX = null;
  norm.forEach(it=>{ if (!dateX && it.str && it.str.match(datePattern)) dateX = it.x; });
  if (!dateX) dateX = Math.min(...norm.map(n=>n.x));

  // determine detail region as between dateX and first money column
  const firstMoneyX = [paidOutX, paidInX, balanceX].filter(Boolean).sort((a,b)=>a-b)[0] || null;

  // helper: find nearest item in row to an x position that matches money
  function findMoneyAt(rowItems, targetX){
    if (!targetX) return null;
    let best = null; let bestDist = Infinity;
    rowItems.forEach(it=>{
      if (!it.str.match(moneyRegex)) return;
      const d = Math.abs(it.x - targetX);
      if (d < bestDist) { bestDist = d; best = it.str.replace(/,/g,''); }
    });
    return best;
  }

  const out = [];
  let currentDate = null;
  let lastRowObj = null;
  rows.forEach(r=>{
    const rowItems = r.items;
    // extract date if present
    const dateItem = rowItems.find(it=>it.str && it.str.match(datePattern));
    const date = dateItem ? dateItem.str.match(datePattern)[0].trim() : null;
    // build details: items between dateX and firstMoneyX
    const detailsParts = rowItems.filter(it=> it.x > dateX + 1 && (firstMoneyX==null || it.x < firstMoneyX - 1)).map(it=>it.str);
    const detailsText = detailsParts.join(' ').trim();
    // payment type: small uppercase token near left of details
    const paymentTypeItem = rowItems.find(it=>/^[A-Z]{1,5}$/.test(it.str));
    const paymentType = paymentTypeItem ? paymentTypeItem.str : '';
    // amounts
    const bal = findMoneyAt(rowItems, balanceX);
    const pin = findMoneyAt(rowItems, paidInX);
    const pout = findMoneyAt(rowItems, paidOutX);

    if (date) {
      currentDate = date;
      const t = { date: currentDate, paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
      out.push(t);
      lastRowObj = t;
    } else {
      // no date on this row
      // if row has amounts or paymentType, treat as new transaction for currentDate
      if ((pout||pin||bal) || paymentType) {
        const t = { date: currentDate || '', paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
        // skip lines that are clearly header/footer or contain no descriptive text (only amounts)
        if (!isHeaderText(t.details1) && (t.details1 || t.paymentType || t.paidOut || t.paidIn || t.balance)) {
          out.push(t);
          lastRowObj = t;
        }
      } else if (detailsText) {
        // continuation of previous transaction
        if (lastRowObj) {
          if (!lastRowObj.details2) lastRowObj.details2 = detailsText; else lastRowObj.details2 += ' ' + detailsText;
        }
      }
    }
  });
  return out;
}

function renderPreview(rows) {
  if (!rows.length) { preview.innerHTML = '<p>No transactions found.</p>'; return; }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Date</th><th>Payment Type</th><th>Details 1</th><th>Details 2</th><th>Paid In</th><th>Paid Out</th><th>Balance</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.paymentType)}</td><td>${escapeHtml(r.details1)}</td><td>${escapeHtml(r.details2)}</td><td>${escapeHtml(r.paidIn)}</td><td>${escapeHtml(r.paidOut)}</td><td>${escapeHtml(r.balance)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  preview.innerHTML = '';
  preview.appendChild(table);
}

function escapeHtml(s){ return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildCsv(rows) {
  const header = ['Date','Payment Type','Details 1','Details 2','Paid In','Paid Out','Balance'];
  const lines = [header.join(',')];
  rows.forEach(r=>{
    const vals = [r.date, r.paymentType, r.details1, r.details2, r.paidIn, r.paidOut, r.balance];
    const escaped = vals.map(v => '"' + (''+v).replace(/"/g,'""') + '"');
    lines.push(escaped.join(','));
  });
  return lines.join('\n');
}

downloadCsv.addEventListener('click', ()=>{
  const csv = buildCsv(parsedRows);
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  triggerDownload(url, 'transactions.csv');
});

downloadXlsx.addEventListener('click', ()=>{
  const wsData = [ ['Date','Payment Type','Details 1','Details 2','Paid In','Paid Out','Balance'] ];
  parsedRows.forEach(r=> wsData.push([r.date,r.paymentType,r.details1,r.details2,r.paidIn,r.paidOut,r.balance]));
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  const wbout = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  const blob = new Blob([wbout], {type:'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  triggerDownload(url, 'transactions.xlsx');
});

downloadXml.addEventListener('click', ()=>{
  const xml = buildXml(parsedRows);
  const blob = new Blob([xml], {type:'application/xml'});
  const url = URL.createObjectURL(blob);
  triggerDownload(url, 'transactions.xml');
});

function buildXml(rows){
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<transactions>\n';
  rows.forEach(r=>{
    out += '  <transaction>\n';
    out += `    <date>${xmlEsc(r.date)}</date>\n`;
    out += `    <paymentType>${xmlEsc(r.paymentType)}</paymentType>\n`;
    out += `    <details1>${xmlEsc(r.details1)}</details1>\n`;
    out += `    <details2>${xmlEsc(r.details2)}</details2>\n`;
    out += `    <paidIn>${xmlEsc(r.paidIn)}</paidIn>\n`;
    out += `    <paidOut>${xmlEsc(r.paidOut)}</paidOut>\n`;
    out += `    <balance>${xmlEsc(r.balance)}</balance>\n`;
    out += '  </transaction>\n';
  });
  out += '</transactions>\n';
  return out;
}

function xmlEsc(s){ return (''+s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function triggerDownload(url, filename){
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}
