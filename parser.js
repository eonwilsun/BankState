// Parser helpers extracted to their own file so they can be reused in tests and the main app.
// Exposes: window.isHeaderText, window.parseLinesToTransactions, window.parsePageItemsToRows

(function(){
  function isHeaderText(s) {
    if (!s) return false;
    const ss = s.toLowerCase();
    if (ss.includes('payment type') || ss.includes('your bank account') || ss.includes('balance brought') || ss.includes('balance carried') || ss.includes('account name')) return true;
    return false;
  }

  function mapMoneyArray(moneyArr, paymentType) {
    let paidOut = '';
    let paidIn = '';
    let balance = '';
    if (moneyArr.length >= 3) {
      paidOut = moneyArr[0];
      paidIn = moneyArr[1];
      balance = moneyArr[2];
    } else if (moneyArr.length === 2) {
      // two-money-column statement: prefer (paidOut, balance) but allow header override elsewhere
      paidOut = moneyArr[0];
      balance = moneyArr[1];
    } else if (moneyArr.length === 1) {
      if (paymentType === 'CR') paidIn = moneyArr[0]; else paidOut = moneyArr[0];
    }
    return {paidIn, paidOut, balance};
  }

  function parseLinesToTransactions(lines) {
    const rows = [];
    const dateRegex = /^\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})\b/; // e.g., 19 Oct 22
    const moneyRegex = /\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2}/g;

    let currentDate = null;
    let lastTransaction = null;

    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] || '').trim();
      if (!line) continue;

      const dmatch = line.match(dateRegex);
      if (dmatch) {
        currentDate = dmatch[1];
        let rest = line.slice(line.indexOf(dmatch[0]) + dmatch[0].length).trim();
        const paymentType = (rest.match(/^([A-Z]{1,5})\b/) || [])[1] || '';
        let moneyFound = (line.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));

        const details = [];
        if (rest) {
          const noMoney = rest.replace(moneyRegex, '').replace(/^([A-Z]{1,5})\b/, '').trim();
          if (noMoney) details.push(noMoney);
        }

        let j = i + 1;
        while (j < lines.length) {
          const nxt = (lines[j] || '').trim();
          if (!nxt) { j++; continue; }
          if (dateRegex.test(nxt)) break;
          const nxtMoney = (nxt.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));
          if (nxtMoney.length > 0) {
            moneyFound = moneyFound.concat(nxtMoney);
            const textOnly = nxt.replace(moneyRegex, '').trim();
            if (textOnly) details.push(textOnly);
            j++; continue;
          }
          details.push(nxt);
          j++;
        }

        const mapped = mapMoneyArray(moneyFound, paymentType);
        const t = {
          date: currentDate,
          paymentType,
          details1: details[0] || '',
          details2: details.slice(1).join(' ') || '',
          paidIn: mapped.paidIn || '',
          paidOut: mapped.paidOut || '',
          balance: mapped.balance || ''
        };
        rows.push(t);
        lastTransaction = t;
        i = j - 1;
        continue;
      }

      const moneyFound = (line.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));
      const startsWithPayment = !!line.match(/^([A-Z]{1,5})\b/);
      if ((moneyFound.length > 0) || startsWithPayment) {
        const paymentType = (line.match(/^([A-Z]{1,5})\b/) || [])[1] || '';
        const rest = line.replace(/^([A-Z]{1,5})\b/, '').replace(moneyRegex, '').trim();
        const details = rest ? [rest] : [];
        const mapped = mapMoneyArray(moneyFound, paymentType);
        const t = {
          date: currentDate || '',
          paymentType,
          details1: details[0] || '',
          details2: details.slice(1).join(' ') || '',
          paidIn: mapped.paidIn || '',
          paidOut: mapped.paidOut || '',
          balance: mapped.balance || ''
        };
        if (!isHeaderText(t.details1) && (t.details1 || t.paymentType || t.paidOut || t.paidIn || t.balance)) {
          rows.push(t);
          lastTransaction = t;
        }
        continue;
      }

      if (lastTransaction) {
        if (!lastTransaction.details2) lastTransaction.details2 = line; else lastTransaction.details2 += ' ' + line;
      }
    }
    return rows;
  }

  function parsePageItemsToRows(items) {
    const moneyRegex = /\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2}/g;
    const norm = items.map(it => ({x: it.transform[4], y: Math.round(it.transform[5]), str: it.str}));
    const ymap = new Map();
    norm.forEach(it => {
      const arr = ymap.get(it.y) || [];
      arr.push(it);
      ymap.set(it.y, arr);
    });
    const ys = Array.from(ymap.keys()).sort((a,b)=>b-a);
    const rows = ys.map(y => ({ y, items: ymap.get(y).sort((a,b)=>a.x-b.x) }));

    const moneyXs = [];
    norm.forEach(it => { if (it.str && it.str.match(moneyRegex)) moneyXs.push(Math.round(it.x)); });
    const uniqMoneyXs = Array.from(new Set(moneyXs)).sort((a,b)=>a-b);

    // Improved header detection: handle headers split across multiple text items
    const headerMap = {};
    const paidCandidates = [];
    const outCandidates = [];
    const inCandidates = [];
    norm.forEach(it => {
      const s = (it.str||'').toLowerCase();
      if (s.includes('date')) headerMap.date = it.x;
      if (s.includes('balance')) headerMap.balance = it.x;
      if (s.includes('paid')) paidCandidates.push(it.x);
      if (s.includes('out')) outCandidates.push(it.x);
      if (s.includes('in')) inCandidates.push(it.x);
    });

    // match paid + out/in by proximity
    function nearestMatch(aList, bList) {
      if (!aList.length || !bList.length) return null;
      let best = null; let bestDist = Infinity;
      aList.forEach(a => {
        bList.forEach(b => {
          const d = Math.abs(a - b);
          if (d < bestDist) { bestDist = d; best = {a,b}; }
        });
      });
      return best;
    }

    let paidOutX = null, paidInX = null, balanceX = null;
    const outMatch = nearestMatch(paidCandidates, outCandidates);
    if (outMatch) paidOutX = outMatch.b;
    const inMatch = nearestMatch(paidCandidates, inCandidates);
    if (inMatch) paidInX = inMatch.b;
    if (headerMap.balance) balanceX = headerMap.balance;

    // Fill remaining from detected money columns (fallback)
    if (!balanceX && uniqMoneyXs.length) balanceX = uniqMoneyXs[uniqMoneyXs.length-1];
    if (!paidInX && uniqMoneyXs.length>=3) paidInX = uniqMoneyXs[uniqMoneyXs.length-2];
    if (!paidOutX && uniqMoneyXs.length>=2) paidOutX = uniqMoneyXs[0];

    // If only two money columns and header positions exist, prefer header-based mapping
    if (uniqMoneyXs.length === 2 && (paidInX || paidOutX)) {
      if (!paidInX && headerMap.paidIn) paidInX = headerMap.paidIn;
      if (!paidOutX && headerMap.paidOut) paidOutX = headerMap.paidOut;
    }

    // Debug: log detected columns
    // console.debug('money columns', { uniqMoneyXs, paidOutX, paidInX, balanceX, headerMap });

    // dateX detection
    const datePattern = /^\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\b/;
    let dateX = null;
    norm.forEach(it=>{ if (!dateX && it.str && it.str.match(datePattern)) dateX = it.x; });
    if (!dateX) dateX = Math.min(...norm.map(n=>n.x));

    const firstMoneyX = [paidOutX, paidInX, balanceX].filter(Boolean).sort((a,b)=>a-b)[0] || null;

    function findMoneyAt(rowItems, targetX){
      if (!targetX) return null;
      let best = null; let bestDist = Infinity;
      rowItems.forEach(it=>{ if (!it.str.match(moneyRegex)) return; const d = Math.abs(it.x - targetX); if (d < bestDist) { bestDist = d; best = it.str.replace(/,/g,''); }});
      return best;
    }

    const out = [];
    let currentDate = null;
    let lastRowObj = null;
    rows.forEach(r=>{
      const rowItems = r.items;
      const dateItem = rowItems.find(it=>it.str && it.str.match(datePattern));
      const date = dateItem ? dateItem.str.match(datePattern)[0].trim() : null;
      const detailsParts = rowItems.filter(it=> it.x > dateX + 1 && (firstMoneyX==null || it.x < firstMoneyX - 1)).map(it=>it.str);
      const detailsText = detailsParts.join(' ').trim();
      const paymentTypeItem = rowItems.find(it=>/^[A-Z]{1,5}$/.test(it.str));
      const paymentType = paymentTypeItem ? paymentTypeItem.str : '';
      const bal = findMoneyAt(rowItems, balanceX);
      const pin = findMoneyAt(rowItems, paidInX);
      const pout = findMoneyAt(rowItems, paidOutX);

      if (date) {
        currentDate = date;
        const t = { date: currentDate, paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
        out.push(t); lastRowObj = t;
      } else {
        if ((pout||pin||bal) || paymentType) {
          const t = { date: currentDate || '', paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
          if (!isHeaderText(t.details1) && (t.details1 || t.paymentType || t.paidOut || t.paidIn || t.balance)) { out.push(t); lastRowObj = t; }
        } else if (detailsText) {
          if (lastRowObj) { if (!lastRowObj.details2) lastRowObj.details2 = detailsText; else lastRowObj.details2 += ' ' + detailsText; }
        }
      }
    });
    return out;
  }

  // export
  window.isHeaderText = isHeaderText;
  window.parseLinesToTransactions = parseLinesToTransactions;
  window.parsePageItemsToRows = parsePageItemsToRows;
})();
