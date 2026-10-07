# PSE Stocks Watchlist by Nialo

A small web app that shows near real-time Philippine Stock Exchange prices, pulled from
[PSE Edge](https://edge.pse.com.ph/), for the stocks on your own watchlist.

## Features

- **Index summary**: PSEi and the sector indices (value, change, % change), market status,
  total volume, trades and value, and advances/declines/unchanged, refreshed with the
  watchlist. On wide screens it sits on the left; on phones and tablets it's a bar above the
  watchlist showing the PSEi, which you tap to expand.
- **Watchlist**: search by symbol or company name, add with a click or Enter, and remove with ×.
  The list is saved in your browser, so it's still there next time you open the app.
- **Browse all stocks**: next to the search box is a dropdown of every PSE-listed stock,
  A–Z by symbol and grouped by first letter. Scroll and pick one to add it. Stocks already
  on your watchlist are marked ✓ and greyed out.
- **Sections**: group stocks into your own sections (for example "Banks" or "Long-term").
  Use **+ New section** to create one and **Add to** to pick where new stocks go. Rename a
  section with the pencil button or by double-clicking its name, collapse it with the arrow,
  or delete it with the bin.
- **Drag to reorder**: drag the dotted handle on the left of a stock to move it, including
  into another section. Section headers have a handle too. With a mouse, touch or keyboard
  (focus a handle and press the up and down arrow keys).
- **Market schedule** in the header: shows each PSE trading phase, highlights the current one,
  and counts down to the next (for example "Lunch recess in 1h 45m").
- **Auto-refresh** every 15s, 30s, 1m or 5m, or paused. Refreshing slows to every 5 minutes
  outside PSE trading hours and stops while the tab is hidden.
- For each stock: last traded price, change, % change, open, high, low, previous close,
  volume and a 30-day sparkline. Prices flash green or red when they move.
- Click any column header to sort within each section. A third click returns to your own
  order. Dragging a stock while sorted keeps the sorted order as your new order.
- Click a symbol to open its page on PSE Edge.
- Light and dark mode: follows your device setting until you pick one with the sun/moon
  button in the header, then remembers your choice.
- Works on phones; less important columns are hidden on narrow screens.

## Running it

You need [Node.js](https://nodejs.org/) 18 or newer. There are no dependencies to install.

Get the code and run it from inside its folder (the same commands work in PowerShell
on Windows and in a macOS or Linux terminal):

```sh
cd ~
git clone https://github.com/nialo22/PSE-Stocks.git
cd PSE-Stocks
npm start
```

Then open <http://127.0.0.1:3000>. Press Ctrl+C in the terminal to stop the app.

`npm` commands must be run from the `PSE-Stocks` folder. Running them anywhere else
(such as `C:\Windows\system32`) fails with `ENOENT: no such file or directory, open ...package.json`.

To set an option below, put it in front of the command on macOS or Linux
(`PORT=4000 npm start`); in PowerShell, set it first (`$env:PORT=4000; npm start`).

| Variable       | Default     | Purpose                                              |
| -------------- | ----------- | ---------------------------------------------------- |
| `PORT`         | `3000`      | Port to listen on                                    |
| `HOST`         | `127.0.0.1` | Interface to bind (`0.0.0.0` to reach it from your phone on the same network) |
| `QUOTE_TTL_MS` | `15000`     | How long a fetched quote is reused before PSE Edge is asked again |
| `DEMO`         | unset       | `1` serves simulated prices, for trying the app without internet access |

`npm run demo` starts the app with simulated prices on any platform. A banner makes it clear the data is not real.

## How it works

PSE Edge has no public API, and browsers can't call it directly from another site, so
`server.js` fetches from PSE Edge itself and gives the page a small JSON API:

| App endpoint                         | PSE Edge source                                           |
| ------------------------------------ | --------------------------------------------------------- |
| `GET /api/search?q=jollibee`         | `/autoComplete/searchCompanyNameSymbol.ax` (company search) |
| `GET /api/indices`                   | `/index/form.do` (index summary and market totals)         |
| `GET /api/companies`                 | `/companyDirectory/search.ax` (every listed company, all pages) |
| `GET /api/quotes?symbols=JFC,ALI`    | `/companyPage/stockData.do` (stock data page, parsed from HTML) |
| `GET /api/history?symbol=JFC&days=30`| `/common/DisclosureCht.ax` (daily price chart data)       |

The full company list is cached for 12 hours. Quotes are cached for 15 seconds on the server, so several open tabs don't multiply
requests to PSE Edge. Companies with more than one listed security (for example common
and preferred shares) are handled: the app picks the security that matches the symbol.

The parsing code is in `lib/pse.js`. If PSE Edge changes its page layout and prices stop
showing, that file is the place to fix, and `test/fixtures/stockData.html` shows the
layout it expects.

## Tests

```sh
npm test
```

## Notes

- "Real time" here means as fresh as PSE Edge publishes. PSE Edge may lag the trading floor.
- The market schedule follows PSE's regular weekday sessions (pre-open 9:00, trading
  9:30–12:00 and 1:00–2:45, pre-close 2:45, run-off 2:50, close 3:00 PM Manila time).
  It doesn't know about exchange holidays or special trading days.
- Please keep the refresh interval reasonable. PSE Edge is a public service.
- This app is for information only and is not investment advice.
