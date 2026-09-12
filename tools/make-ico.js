'use strict';

/**
 * Writes the app's icon as a Windows `.ico`.
 *
 * The drawing lives in src/main/icon.js and is produced in code, so the
 * repository can stay free of binary assets: this regenerates the one file that
 * the packager and the desktop shortcut both ask for.
 *
 *   node tools/make-ico.js
 */
const fs = require('fs');
const path = require('path');

const { iconIco } = require('../src/main/icon');

const TARGET = path.join(__dirname, '..', 'assets', 'win-duo.ico');

function writeIco() {
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, iconIco());
  return TARGET;
}

module.exports = { writeIco, TARGET };

if (require.main === module) {
  console.log(`[win-duo] wrote ${writeIco()}`);
}
