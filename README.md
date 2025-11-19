# BankState — PDF → CSV/XLSX/XML

This is a small client-side site that extracts transaction lines from a PDF bank statement and exports them as CSV, XLSX or XML.

How to use
- Open `index.html` in a browser (or serve it via GitHub Pages).
- Upload a PDF bank statement using the file input and click `Parse PDF`.
- Preview the parsed transactions and click `Download CSV` / `Download XLSX` / `Download XML`.

Notes and limitations
- The parser uses heuristics: it detects transactions by lines that start with a date like `19 Oct 22`.
- Details spanning two lines are placed into `Details 1` and `Details 2` cells; if there is only one detail line, `Details 2` is blank.
- Rows containing `BALANCE BROUGHT FORWARD` or `BALANCE CARRIED FORWARD` are ignored.
- Parsing accuracy depends on how well PDF.js reconstructs text lines from your PDF. If parsing fails on some statements, please share a sample PDF and I can tweak the parsing rules.

Publishing
- To publish as GitHub Pages, push this folder as a repository and enable Pages or host the built site from `main` branch root.
