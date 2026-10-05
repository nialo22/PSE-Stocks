# PSE Stocks Watchlist by Nialo

A small web app that shows near real-time Philippine Stock Exchange prices, pulled from
[PSE Edge](https://edge.pse.com.ph/), for the stocks on your own watchlist.

## Features

- **Watchlist**: search by symbol or company name, add with a click or Enter, and remove with ×.
  The list is saved in your browser, so it's still there next time you open the app.
- **Auto-refresh** every 15s, 30s, 1m or 5m, or paused. Refreshing slows to every 5 minutes
  outside PSE trading hours and stops while the tab is hidden.
- For each stock: last traded price, change, % change, open, high, low, previous close,
  volume and a 30-day sparkline. Prices flash green or red when they move.
- Click any column header to sort. A third click returns to your own order.
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
| `GET /api/quotes?symbols=JFC,ALI`    | `/companyPage/stockData.do` (stock data page, parsed from HTML) |
| `GET /api/history?symbol=JFC&days=30`| `/common/DisclosureCht.ax` (daily price chart data)       |

Quotes are cached for 15 seconds on the server, so several open tabs don't multiply
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
- The market open/closed badge is approximate: weekdays, about 9:30 AM to 3:00 PM Manila
  time. It doesn't know about exchange holidays.
- Please keep the refresh interval reasonable. PSE Edge is a public service.
- This app is for information only and is not investment advice.
