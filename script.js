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

// Helper to detect obvious header/footer lines (used by multiple parsers)
window.isHeaderText = function(s) {
  if (!s) return false;
  const ss = s.toLowerCase();
  if (ss.includes('payment type') || ss.includes('your bank account') || ss.includes('balance brought') || ss.includes('balance carried') || ss.includes('account name')) return true;
  return false;
};

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
    console.debug('parsedRows', parsedRows.slice(0,30));
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error reading PDF: see console.';
  }
});

// Parser functions (parseLinesToTransactions / parsePageItemsToRows) are provided by `parser.js`.
// `parser.js` is included before `script.js` in `index.html` so the functions are available on `window`.

function renderPreview(rows) {
  if (!rows.length) { preview.innerHTML = '<p>No transactions found.</p>'; return; }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Date</th><th>Payment Type</th><th>Details 1</th><th>Details 2</th><th>Paid Out</th><th>Paid In</th><th>Balance</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  let lastDisplayDate = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    // Display the row date or fall back to the last non-empty date seen above
    const displayDate = (r.date && r.date.toString().trim()) ? r.date : lastDisplayDate;
    if (displayDate) lastDisplayDate = displayDate;
    // Render columns in PDF visual order: Paid Out, Paid In, Balance
    tr.innerHTML = `<td>${escapeHtml(displayDate)}</td><td>${escapeHtml(r.paymentType)}</td><td>${escapeHtml(r.details1)}</td><td>${escapeHtml(r.details2)}</td><td>${escapeHtml(r.paidOut)}</td><td>${escapeHtml(r.paidIn)}</td><td>${escapeHtml(r.balance)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  preview.innerHTML = '';
  preview.appendChild(table);
}

function escapeHtml(s){ return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildCsv(rows) {
  const header = ['Date','Payment Type','Details 1','Details 2','Paid Out','Paid In','Balance'];
  const lines = [header.join(',')];
  rows.forEach(r=>{
    const vals = [r.date, r.paymentType, r.details1, r.details2, r.paidOut, r.paidIn, r.balance];
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
  const wsData = [ ['Date','Payment Type','Details 1','Details 2','Paid Out','Paid In','Balance'] ];
  parsedRows.forEach(r=> wsData.push([r.date,r.paymentType,r.details1,r.details2,r.paidOut,r.paidIn,r.balance]));
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
      out += `    <paidOut>${xmlEsc(r.paidOut)}</paidOut>\n`;
      out += `    <paidIn>${xmlEsc(r.paidIn)}</paidIn>\n`;
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
