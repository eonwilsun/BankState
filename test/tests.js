(function(){
  const out = document.getElementById('out');
  function log(...args){ out.textContent += args.join(' ') + '\n'; }

  // Basic unit tests for mapping money arrays and simple lines
  function assertEq(a,b,msg){ if (JSON.stringify(a)!==JSON.stringify(b)) { log('FAIL:', msg); log('  expected:', JSON.stringify(b)); log('  got:     ', JSON.stringify(a)); throw new Error('Test failed: '+msg); } else { log('OK:', msg); } }

  // Test 1: simple date + single amount (debit)
  const lines1 = [ '12 Nov 16 VIS SOME SHOP 8.10 8.10 8.10' ];
  const rows1 = parseLinesToTransactions(lines1);
  assertEq(rows1.length, 1, 'single-row parsed');
  assertEq(rows1[0].date, '12 Nov 16', 'date parsed');
  // amounts appear left-to-right: paidOut, paidIn?, balance => with 3 tokens map to paidOut, paidIn, balance

  // Test 2: continuation lines
  const lines2 = [ '13 Nov 16', 'VIS SHOP NAME 7.99 7.99', 'MORE DETAILS' ];
  const rows2 = parseLinesToTransactions(lines2);
  assertEq(rows2.length, 1, 'continuation lines grouped');
  assertEq(rows2[0].details2.includes('MORE DETAILS'), true, 'details2 contains continuation');

  // Test 3: two money columns (left=paidOut, right=balance)
  const lines3 = [ '14 Nov 16 TFR 50.00 850.00' ];
  const rows3 = parseLinesToTransactions(lines3);
  assertEq(rows3[0].paidOut, '50.00', 'paidOut mapped (two columns)');
  assertEq(rows3[0].balance, '850.00', 'balance mapped (two columns)');

  // Test 4: parsePageItemsToRows should skip image placeholder rows (data:image...)
  const items4 = [
    { transform: [0,0,0,0,10,700], str: 'dataimage1' },
    { transform: [0,0,0,0,50,680], str: '13 Nov 16' },
    { transform: [0,0,0,0,120,680], str: 'VIS' },
    { transform: [0,0,0,0,200,680], str: 'GWR TAUNTON SST' },
    { transform: [0,0,0,0,500,680], str: '8.10' }
  ];
  const rows4 = parsePageItemsToRows(items4);
  assertEq(rows4.length, 1, 'skips image placeholder and parses first transaction');
  assertEq(rows4[0].details1.includes('GWR TAUNTON'), true, 'details preserved after skipping image');

  // Test 5: multi-line transaction (second visual line without date should merge into details2)
  const items5 = [
    { transform: [0,0,0,0,50,660], str: '14 Nov 16' },
    { transform: [0,0,0,0,120,660], str: 'VIS' },
    { transform: [0,0,0,0,200,660], str: 'GWR WESTON SUP SST' },
    { transform: [0,0,0,0,500,660], str: '8.10' },
    // continuation line below with no date and no money
    { transform: [0,0,0,0,200,645], str: 'WESTON-S-MARE' }
  ];
  const rows5 = parsePageItemsToRows(items5);
  assertEq(rows5.length, 1, 'multi-line page items merged into single transaction');
  assertEq(rows5[0].details2.includes('WESTON-S-MARE'), true, 'continuation appended to details2');

  // Test 6: amounts on the following visual line should attach to the previous details
  const items6 = [
    { transform: [0,0,0,0,50,640], str: '14 Nov 16' },
    { transform: [0,0,0,0,120,640], str: 'VIS' },
    { transform: [0,0,0,0,200,640], str: 'GWR TAUNTON SST' },
    // next visual line contains the place (TAUNTON) and the amounts — should attach to previous
    { transform: [0,0,0,0,200,620], str: 'TAUNTON' },
    { transform: [0,0,0,0,500,620], str: '8.10' }
  ];
  const rows6 = parsePageItemsToRows(items6);
  assertEq(rows6.length, 1, 'amounts on following line attach to previous transaction');
  assertEq(rows6[0].details2.includes('TAUNTON'), true, 'TAUNTON appended to details2');
  assertEq(rows6[0].paidOut === '8.10' || rows6[0].paidIn === '8.10', true, 'amount attached to previous transaction');

  // Test 7: skip leading summary rows and start at first real transaction date
  const items7 = [
    { transform: [0,0,0,0,50,780], str: 'Opening Balance' },
    { transform: [0,0,0,0,200,760], str: 'Overdraft Limit' },
    { transform: [0,0,0,0,50,740], str: '12 Nov 16' },
    { transform: [0,0,0,0,120,740], str: 'VIS' },
    { transform: [0,0,0,0,200,740], str: 'GWR TAUNTON SST' },
    { transform: [0,0,0,0,500,740], str: '8.10' }
  ];
  const rows7 = parsePageItemsToRows(items7);
  assertEq(rows7.length, 1, 'leading summaries are skipped and transactions start at first date');
  assertEq(rows7[0].date.includes('12 Nov'), true, 'first transaction date preserved');

  log('All tests passed.');
})();