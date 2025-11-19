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
    let fullLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const text = await page.getTextContent();
      // group by rounded y coordinate
      const map = new Map();
      text.items.forEach(item => {
        const y = Math.round(item.transform[5]);
        const existing = map.get(y) || [];
        existing.push({x: item.transform[4], str: item.str});
        map.set(y, existing);
      });
      // sort by y descending (top to bottom) and within line by x
      const ys = Array.from(map.keys()).sort((a,b)=>b-a);
      ys.forEach(y=>{
        const items = map.get(y).sort((a,b)=>a.x-b.x);
        const line = items.map(i=>i.str).join(' ').trim();
        if (line) fullLines.push(line);
      });
    }

    statusEl.textContent = 'Parsing transactions...';
    parsedRows = parseLinesToTransactions(fullLines);
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
    if (dmatch) {
      // Line contains a date — treat as a new transaction starting point
      currentDate = dmatch[1];
      if (carryForwardRegex.test(raw)) continue;
      const rest = raw.slice(dmatch[0].length).trim();
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
