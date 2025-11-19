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
    let rows = ys.map(y => ({ y, items: ymap.get(y).sort((a,b)=>a.x-b.x) }));

    // Remove rows that are just image placeholders from PDF extraction (these often
    // contain strings like 'dataimage' or 'data:image' and may include private data).
    rows = rows.filter(r => !r.items.some(it => /data:image|dataimage/i.test(it.str || '')));

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
    // Prefer explicit header positions when present
    if (headerMap.balance) balanceX = headerMap.balance;

    // If we have money X positions, try to map them to Paid Out / Paid In by
    // choosing the money column whose X is closest to the 'out' header and the
    // one closest to the 'in' header. This handles statements where the two
    // amount columns may appear in either order visually.
    const moneyCols = uniqMoneyXs.slice();
    if (moneyCols.length > 0) {
      // If balanceX not set, assume the right-most money column is balance
      if (!balanceX) balanceX = moneyCols[moneyCols.length - 1];

      // Consider candidate money columns excluding the balance column
      const candidateMoney = moneyCols.filter(x => Math.abs(x - balanceX) > 1);

      // Helper to compute nearest distance to a list
      const nearestDistToList = (x, list) => {
        if (!list || !list.length) return Infinity;
        return Math.min(...list.map(v => Math.abs(x - v)));
      };

      // For each candidate money column, decide whether it's 'out' or 'in' by
      // measuring proximity to the out/in header tokens (if available).
      const assignments = candidateMoney.map(mx => {
        const outD = nearestDistToList(mx, outCandidates);
        const inD = nearestDistToList(mx, inCandidates);
        return { x: mx, outD, inD };
      });

      // Prefer header-based assignment when header tokens are present
      if (outCandidates.length || inCandidates.length) {
        assignments.forEach(a => {
          if (a.outD < a.inD) paidOutX = a.x;
          else paidInX = a.x;
        });
      }

      // Fallback: if we still don't have both, assign by left-to-right order
      const assigned = [paidOutX, paidInX].filter(Boolean);
      const unassigned = candidateMoney.filter(x => !assigned.includes(x));
      const sortedCandidates = candidateMoney.sort((a,b)=>a-b);
      if (!paidOutX && sortedCandidates.length) paidOutX = sortedCandidates[0];
      if (!paidInX && sortedCandidates.length > 1) paidInX = sortedCandidates[1];
      // If only one candidate and balance is separate, single amount likely Paid Out
      if (!paidInX && !paidOutX && sortedCandidates.length === 1) paidOutX = sortedCandidates[0];
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
    const PAYMENT_TYPES = ['VIS','ATM','DD','TFR','CR','DR','POS','CHG','INT','SO','SOE','CHEQUE',')))' ];
    // If there are leading rows with no useful data (e.g., leftover image placeholders),
    // start processing from the first row that contains a date or a money token.
    const startIndex = rows.findIndex(r => r.items.some(it => (it.str||'').match(datePattern) || (it.str||'').match(moneyRegex)));
    if (startIndex > 0) rows = rows.slice(startIndex);

    rows.forEach(r=>{
      const rowItems = r.items;
      const dateItem = rowItems.find(it=>it.str && it.str.match(datePattern));
      const date = dateItem ? dateItem.str.match(datePattern)[0].trim() : null;
      // Find canonical payment type token by whitelist first (avoids confusing merchant tokens like 'GWR')
      let paymentTypeItem = rowItems.find(it => PAYMENT_TYPES.includes((it.str||'').toUpperCase()));
      if (!paymentTypeItem) {
        // fallback: short uppercase token immediately after date
        paymentTypeItem = rowItems.find(it => /^([A-Z]{2,4})$/.test(it.str) && it.x > (dateX || 0));
      }
      const paymentType = paymentTypeItem ? paymentTypeItem.str : '';
      // Build details from row items excluding date text, money tokens and the detected payment type item
      const detailsParts = rowItems.filter(it=> {
        if (!it.str) return false;
        if (it.str.match(datePattern)) return false;
        if (it.str.match(moneyRegex)) return false;
        if (paymentTypeItem && it === paymentTypeItem) return false;
        return true;
      }).map(it=>it.str);
      const detailsText = detailsParts.join(' ').trim();
      // Collect money tokens present on this visual row along with their X
      const moneyItems = rowItems
        .filter(it => it.str && it.str.match(moneyRegex))
        .map(it => ({ x: Math.round(it.x), str: it.str.replace(/,/g,'') }))
        .sort((a,b) => a.x - b.x);
      let bal = null, pin = null, pout = null;
      if (moneyItems.length) {
        // Choose the right-most money token as the Balance (most statements place balance at the far right)
        const balanceCandidate = moneyItems[moneyItems.length - 1];
        bal = balanceCandidate.str;

        // Remaining tokens on the left (could be 0,1,2...)
        const remaining = moneyItems.slice(0, moneyItems.length - 1);

        if (remaining.length === 1) {
          // Single remaining amount: treat as Paid In if payment type looks like credit, otherwise Paid Out
          const single = remaining[0].str;
          const pt = (paymentType||'').toUpperCase();
          if (pt === 'CR' || pt === 'CR+' || pt === 'CRD') pin = single; else pout = single;
        } else if (remaining.length >= 2) {
          // Multiple remaining amounts: assign left-most => Paid Out, right-most => Paid In
          pout = remaining[0].str;
          pin = remaining[remaining.length - 1].str;
        }
      }

      if (date) {
        currentDate = date;
        const t = { date: currentDate, paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
        // If both paidIn and paidOut are present, choose one based on paymentType
        if (t.paidIn && t.paidOut) {
          const pt = (t.paymentType||'').toUpperCase();
          if (pt === 'CR') t.paidOut = ''; else t.paidIn = '';
        }
        out.push(t); lastRowObj = t;
      } else {
        // No explicit date on this line. If there are money tokens, this is a new
        // transaction row (some statements put the amounts on the next visual line).
        // If there are no money tokens, treat it as a continuation of the previous
        // transaction and append to `details2` (this prevents lines like "TAUNTON"
        // appearing as separate rows).
        if (pout || pin || bal) {
          // If the previous transaction exists and it has details but no amounts,
          // this line likely contains the amounts for that previous transaction
          // (visual layout sometimes places amounts on the following visual line).
          if (lastRowObj && !(lastRowObj.paidIn || lastRowObj.paidOut || lastRowObj.balance) && lastRowObj.details1) {
            // attach amounts and any details text to the previous row
            if (pin) lastRowObj.paidIn = pin;
            if (pout) lastRowObj.paidOut = pout;
            if (bal) lastRowObj.balance = bal;
            if (paymentType && !lastRowObj.paymentType) lastRowObj.paymentType = paymentType;
            if (detailsText) {
              if (!lastRowObj.details2) lastRowObj.details2 = detailsText; else lastRowObj.details2 += ' ' + detailsText;
            }
          } else {
            const t = { date: currentDate || '', paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
            // If both paidIn and paidOut are present, select one based on paymentType
            if (t.paidIn && t.paidOut) {
              const pt = (t.paymentType||'').toUpperCase();
              if (pt === 'CR') t.paidOut = ''; else t.paidIn = '';
            }
            if (!isHeaderText(t.details1) && (t.details1 || t.paymentType || t.paidOut || t.paidIn || t.balance)) { out.push(t); lastRowObj = t; }
          }
        } else if (paymentType) {
          // Payment type without amounts — treat as the start of a transaction row.
          const t = { date: currentDate || '', paymentType, details1: detailsText, details2: '', paidIn: '', paidOut: '', balance: '' };
          if (!isHeaderText(t.details1) && (t.details1 || t.paymentType)) { out.push(t); lastRowObj = t; }
        } else if (detailsText) {
          if (lastRowObj) { if (!lastRowObj.details2) lastRowObj.details2 = detailsText; else lastRowObj.details2 += ' ' + detailsText; }
        }
      }
    });
    // Post-process: remove any rows that contain image placeholders in their text
    const safeOut = out.filter(r => {
      const combined = ((r.date||'') + ' ' + (r.paymentType||'') + ' ' + (r.details1||'') + ' ' + (r.details2||'')).toLowerCase();
      if (/data:image|dataimage/i.test(combined)) return false;
      return true;
    });

    // Find the first real transaction: a row with a date that is NOT a summary/balance row
    const skipSummaryPattern = /balance brought|opening balance|payments in|payments out|closing balance|overdraft limit|balance carried/i;
    // Find the first real transaction row: prefers a dated row that isn't a summary,
    // but will also accept a paymentType row as a transaction start.
    const firstRealIdx = safeOut.findIndex(r => ((r.date && !(skipSummaryPattern.test((r.details1||'') + ' ' + (r.details2||'')))) || (r.paymentType && !(skipSummaryPattern.test((r.details1||'') + ' ' + (r.details2||''))))));
    let result = (firstRealIdx > 0) ? safeOut.slice(firstRealIdx) : safeOut;

    // Remove any trailing summary or carriage markers and everything after them.
    // Many statements use phrases like 'Last Carried Forward', 'Balance Carried Forward',
    // 'Balance Carried' or 'Closing Balance' to mark the end of transactions. Drop those
    // rows and anything after them.
    const endPattern = /last carried forward|balance carried forward|balance carried|closing balance|balance brought forward/i;
    const endIdx = result.findIndex(r => endPattern.test((r.details1||'') + ' ' + (r.details2||'')));
    if (endIdx !== -1) result = result.slice(0, endIdx);

    // Filter out large non-transactional paragraphs often included on statements
    // (policy text, legal disclaimers) and other summary rows that are not
    // real transactions (e.g., Overdraft Limit, IBAN/account headers). We
    // drop rows that match known patterns even if they contain an amount.
    const policyPattern = /financial services compensation scheme|effective from|interest rates|registered in england|ombudsman|financial ombudsman|hsbc bank plc/i;
    const extraSummaryPattern = /overdraft limit|international bank account number|account number|sortcode|registered in england|your bank account details/i;
    result = result.filter(r => {
      const combined = ((r.details1||'') + ' ' + (r.details2||'')).trim();
      const hasDate = !!(r.date);
      const hasPaymentType = !!(r.paymentType);
      const hasAmounts = !!(r.paidIn || r.paidOut || r.balance);
      // Drop obvious policy/legal paragraphs regardless of amounts
      if (policyPattern.test(combined) || extraSummaryPattern.test(combined)) return false;
      // Drop very long non-transaction lines that have no date/payment/amounts
      if (!hasDate && !hasPaymentType && !hasAmounts && combined.length > 200) return false;
      return true;
    });

    // Propagate missing dates: if a row has no date, use the previous row's date.
    let lastDate = '';
    for (let i = 0; i < result.length; i++) {
      if (result[i].date) { lastDate = result[i].date; }
      else { result[i].date = lastDate; }
    }

    return result;
  }

  // export
  window.isHeaderText = isHeaderText;
  window.parseLinesToTransactions = parseLinesToTransactions;
  window.parsePageItemsToRows = parsePageItemsToRows;
})();
