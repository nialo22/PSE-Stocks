'use strict';

// The site has no bundler, so browser code can't import npm packages
// directly. This copies the browser builds it needs into public/vendor/,
// where the page can load them. Runs on `npm run build` (Vercel and Netlify
// run it when deploying) and before `npm start`.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'public', 'vendor');

const files = [
  ['node_modules/@vercel/analytics/dist/index.mjs', 'vercel-analytics.mjs'],
];

fs.mkdirSync(vendorDir, { recursive: true });
for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, from), path.join(vendorDir, to));
  console.log(`Copied ${from} -> public/vendor/${to}`);
}
