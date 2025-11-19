// Parser helpers extracted to their own file so they can be reused in tests and the main app.
// Exposes: window.isHeaderText, window.parseLinesToTransactions, window.parsePageItemsToRows

(function(){
  function isHeaderText(s) {
    if (!s) return false;
    const ss = s.toLowerCase();
    if (ss.includes('payment type') || ss.includes('your bank account') || ss.includes('balance brought') || ss.includes('balance carried') || ss.includes('account name')) return true;
    return false;
  }

  // Payment types that indicate a credit (incoming) amount.
  const CREDIT_TYPES = new Set(['CR','TFR','INT']);
  function isCreditType(pt) {
    if (!pt) return false;
    const clean = (pt||'').toString().toUpperCase().replace(/[^A-Z]/g,'');
    return CREDIT_TYPES.has(clean);
  }

  // Canonical payment-type tokens as they appear in statements.
  const PAYMENT_TYPES = ['VIS','ATM','DD','TFR','CR','DR','POS','CHG','INT','SO','SOE','CHEQUE',')))'];

  function normalizePaidSides(target, fallbackPaymentType, opts) {
    const preferColumnAssignments = !!(opts && opts.preferColumnAssignments);
    const ptRaw = (fallbackPaymentType !== undefined && fallbackPaymentType !== null && fallbackPaymentType !== '')
      ? fallbackPaymentType
      : (target.paymentType || '');
    const credit = isCreditType(ptRaw);

    if (target.paidIn && target.paidOut) {
      if (credit) target.paidOut = ''; else target.paidIn = '';
    }

    if (credit && !target.paidIn && target.paidOut) {
      target.paidIn = target.paidOut;
      target.paidOut = '';
    } else if (!preferColumnAssignments && !credit && target.paidIn && !target.paidOut) {
      target.paidOut = target.paidIn;
      target.paidIn = '';
    }
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
      if (isCreditType(paymentType)) paidIn = moneyArr[0]; else paidOut = moneyArr[0];
    }
    const mapping = { paidIn, paidOut, balance, paymentType };
    normalizePaidSides(mapping, paymentType);
    delete mapping.paymentType;
    return mapping;
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
        let paymentType = (rest.match(/^([A-Z]{1,5})\b/) || [])[1] || '';
        if (!paymentType) {
          for (const pt of PAYMENT_TYPES) {
            const re = new RegExp('\\b' + pt.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + '\\b', 'i');
            if (re.test(rest)) { paymentType = pt; break; }
          }
        }
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
        normalizePaidSides(t, paymentType);
        rows.push(t);
        lastTransaction = t;
        i = j - 1;
        continue;
      }

      const moneyFound = (line.match(moneyRegex) || []).map(s => s.replace(/,/g, ''));
      const startsWithPayment = !!line.match(/^([A-Z]{1,5})\b/);
      if ((moneyFound.length > 0) || startsWithPayment) {
        let paymentType = (line.match(/^([A-Z]{1,5})\b/) || [])[1] || '';
        if (!paymentType) {
          for (const pt of PAYMENT_TYPES) {
            const re = new RegExp('\\b' + pt.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + '\\b', 'i');
            if (re.test(line)) { paymentType = pt; break; }
          }
        }
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
        normalizePaidSides(t, paymentType);
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

    function detectHeaderColumns(candidateRows) {
      const upper = s => (s || '').trim().toLowerCase();
      const header = { paidOut: null, paidIn: null, balance: null };
      const configs = [
        { key: 'paidOut', pattern: /paid\s*out/i, words: ['paid','out'] },
        { key: 'paidIn', pattern: /paid\s*in/i, words: ['paid','in'] },
        { key: 'balance', pattern: /balance/i }
      ];
      candidateRows.forEach(row => {
        if (header.paidOut && header.paidIn && header.balance) return;
        const arr = row.items || [];
        for (let i = 0; i < arr.length; i++) {
          const txt = upper(arr[i].str);
          if (!txt) continue;
          configs.forEach(cfg => {
            if (header[cfg.key]) return;
            if (cfg.pattern.test(txt)) {
              header[cfg.key] = Math.round(arr[i].x);
              return;
            }
            if (cfg.words && cfg.words.length === 2) {
              if (txt === cfg.words[0]) {
                const nextTxt = upper((arr[i+1] || {}).str);
                if (nextTxt === cfg.words[1]) {
                  const nextX = arr[i+1] ? arr[i+1].x : arr[i].x;
                  header[cfg.key] = Math.round((arr[i].x + nextX) / 2);
                }
              }
            }
          });
        }
      });
      return header;
    }

    const headerCols = detectHeaderColumns(rows.slice(0, 20));

    const moneyXs = [];
    norm.forEach(it => { if (it.str && it.str.match(moneyRegex)) moneyXs.push(Math.round(it.x)); });
    const uniqMoneyXs = Array.from(new Set(moneyXs)).sort((a,b)=>a-b);

    function clusterColumns(xs, tolerance) {
      if (!xs.length) return [];
      const centers = [];
      let sum = xs[0];
      let count = 1;
      let prev = xs[0];
      for (let i = 1; i < xs.length; i++) {
        const x = xs[i];
        if (Math.abs(x - prev) <= tolerance) {
          sum += x;
          count++;
        } else {
          centers.push(Math.round(sum / count));
          sum = x;
          count = 1;
        }
        prev = x;
      }
      centers.push(Math.round(sum / count));
      return centers;
    }

    let paidOutX = null, paidInX = null, balanceX = null;
    let columnCenters = clusterColumns(uniqMoneyXs, 6);
    if (columnCenters.length > 3) {
      columnCenters = columnCenters.slice(-3);
    }
    columnCenters.sort((a,b)=>a-b);
    if (columnCenters.length > 0) {
      paidOutX = columnCenters[0];
      balanceX = columnCenters[columnCenters.length - 1];
      if (columnCenters.length >= 3) {
        paidInX = columnCenters[columnCenters.length - 2];
      }
    }

    if (typeof headerCols.paidOut === 'number') paidOutX = headerCols.paidOut;
    if (typeof headerCols.paidIn === 'number') paidInX = headerCols.paidIn;
    if (typeof headerCols.balance === 'number') balanceX = headerCols.balance;

    // Debug: log detected columns
    // console.debug('money columns', { uniqMoneyXs, columnCenters, paidOutX, paidInX, balanceX });

    // dateX detection
    const datePattern = /^\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\b/;
    let dateX = null;
    norm.forEach(it=>{ if (!dateX && it.str && it.str.match(datePattern)) dateX = it.x; });
    if (!dateX) dateX = Math.min(...norm.map(n=>n.x));

    const firstMoneyX = [paidOutX, paidInX, balanceX].filter(Boolean).sort((a,b)=>a-b)[0] || null;

    function assignMoneyByColumns(moneyItems, paymentType) {
      if (!moneyItems.length) return { pin: '', pout: '', bal: '' };
      const tokens = moneyItems.map((tok, idx) => ({ ...tok, idx }));
      const slotDefs = [];
      if (typeof paidOutX === 'number') slotDefs.push({ name: 'paidOut', x: paidOutX });
      if (typeof paidInX === 'number') slotDefs.push({ name: 'paidIn', x: paidInX });
      if (typeof balanceX === 'number') slotDefs.push({ name: 'balance', x: balanceX });

      const values = { paidOut: null, paidIn: null, balance: null };

      if (slotDefs.length) {
        const pairs = [];
        tokens.forEach(tok => {
          slotDefs.forEach(slot => {
            pairs.push({ tokenIdx: tok.idx, slotName: slot.name, dist: Math.abs(tok.x - slot.x) });
          });
        });
        pairs.sort((a,b)=>a.dist-b.dist);
        const usedTokens = new Set();
        const usedSlots = new Set();
        pairs.forEach(pair => {
          if (usedTokens.has(pair.tokenIdx)) return;
          if (usedSlots.has(pair.slotName)) return;
          usedTokens.add(pair.tokenIdx);
          usedSlots.add(pair.slotName);
          const tok = tokens.find(t => t.idx === pair.tokenIdx);
          values[pair.slotName] = tok ? tok.str : '';
        });

        const leftovers = tokens.filter(tok => !usedTokens.has(tok.idx)).sort((a,b)=>a.x-b.x);
        leftovers.forEach(tok => {
          if (values.paidOut === null) values.paidOut = tok.str;
          else if (values.paidIn === null) values.paidIn = tok.str;
          else if (values.balance === null) values.balance = tok.str;
        });
      } else {
        const sorted = tokens.slice().sort((a,b)=>a.x-b.x);
        if (sorted.length) values.paidOut = sorted[0].str;
        if (sorted.length >= 2) values.balance = sorted[sorted.length-1].str;
        if (sorted.length >= 3) values.paidIn = sorted[1].str;
      }

      return {
        pin: values.paidIn || '',
        pout: values.paidOut || '',
        bal: values.balance || ''
      };
    }

    const out = [];
    let currentDate = null;
    let lastRowObj = null;
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
      if (!paymentTypeItem) {
        for (const it of rowItems) {
          if (!it.str) continue;
          for (const pt of PAYMENT_TYPES) {
            const re = new RegExp('\\b' + pt.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') + '\\b', 'i');
            if (re.test(it.str)) { paymentTypeItem = it; break; }
          }
          if (paymentTypeItem) break;
        }
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
        const assigned = assignMoneyByColumns(moneyItems, paymentType);
        pin = assigned.pin || '';
        pout = assigned.pout || '';
        bal = assigned.bal || '';
        if (isCreditType(paymentType) && !pin && pout) {
          pin = pout;
          pout = '';
        }
      }

      if (date) {
        currentDate = date;
        const t = { date: currentDate, paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
        normalizePaidSides(t, paymentType, { preferColumnAssignments: true });
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
            normalizePaidSides(lastRowObj, paymentType || lastRowObj.paymentType, { preferColumnAssignments: true });
          } else {
            const t = { date: currentDate || '', paymentType, details1: detailsText, details2: '', paidIn: pin||'', paidOut: pout||'', balance: bal||'' };
            normalizePaidSides(t, paymentType, { preferColumnAssignments: true });
            if (!isHeaderText(t.details1) && (t.details1 || t.paymentType || t.paidOut || t.paidIn || t.balance)) { out.push(t); lastRowObj = t; }
          }
        } else if (paymentType) {
          // Payment type without amounts — treat as the start of a transaction row.
          const t = { date: currentDate || '', paymentType, details1: detailsText, details2: '', paidIn: '', paidOut: '', balance: '' };
          normalizePaidSides(t, paymentType, { preferColumnAssignments: true });
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
    // percent lines like '19.90 %' or '19.90%' should be ignored (interest rate rows)
    const percentPattern = /\d{1,3}(?:\.\d+)?\s*%/i;
    result = result.filter(r => {
      const detailCombined = ((r.details1||'') + ' ' + (r.details2||'')).trim();
      const rowCombined = (detailCombined + ' ' + (r.paymentType||'') + ' ' + (r.paidIn||'') + ' ' + (r.paidOut||'') + ' ' + (r.balance||'')).trim();
      const hasDate = !!(r.date);
      const hasPaymentType = !!(r.paymentType);
      const hasAmounts = !!(r.paidIn || r.paidOut || r.balance);
      // Drop rows that contain percentage tokens (interest / rate lines)
      if (percentPattern.test(rowCombined)) return false;
      // Drop obvious policy/legal paragraphs regardless of amounts
      if (policyPattern.test(detailCombined) || extraSummaryPattern.test(detailCombined)) return false;
      // Drop very long non-transaction lines that have no date/payment/amounts
      if (!hasDate && !hasPaymentType && !hasAmounts && detailCombined.length > 200) return false;
      return true;
    });

    // Propagate missing dates: if a row has no date, use the previous row's date.
    let lastDate = '';
    for (let i = 0; i < result.length; i++) {
      if (result[i].date) { lastDate = result[i].date; }
      else { result[i].date = lastDate; }
    }

    // Ensure only the last row for each date retains a `balance` value.
    // For earlier rows on the same date, if a `balance` was assigned but
    // neither `paidIn` nor `paidOut` are set, move that amount to the
    // appropriate side (Paid In if paymentType suggests credit, otherwise Paid Out),
    // then clear the `balance` field. This follows the visual PDF rule that
    // balances appear only on the last entry for a date.
    const lastIndexByDate = {};
    result.forEach((r, idx) => {
      if (r.date) lastIndexByDate[r.date] = idx;
    });
    for (let i = 0; i < result.length; i++) {
      const r = result[i];
      const lastIdx = lastIndexByDate[r.date];
      if (lastIdx !== undefined && i !== lastIdx) {
        if (r.balance) {
          // move balance to the appropriate side if no side amount exists
          if (!r.paidIn && !r.paidOut) {
            const pt = (r.paymentType || '').toString();
            if (isCreditType(pt)) r.paidIn = r.balance; else r.paidOut = r.balance;
          }
          r.balance = '';
        }
      }
      normalizePaidSides(r, r.paymentType, { preferColumnAssignments: true });
    }

    return result;
  }

  // export
  window.isHeaderText = isHeaderText;
  window.parseLinesToTransactions = parseLinesToTransactions;
  window.parsePageItemsToRows = parsePageItemsToRows;
})();
