'use strict';

/**
 * Writes the generated icons to disk so they can be looked at.
 *
 *   .\node_modules\.bin\electron.cmd tools\make-icon.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const { iconPng } = require('../src/main/icon');

app.whenReady().then(() => {
  const outDir = path.join(__dirname, '..', 'selftest-output');
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 64, 256]) {
    const file = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(file, iconPng(size));
    console.log(`[win-duo] wrote ${file}`);
  }
  app.exit(0);
});
