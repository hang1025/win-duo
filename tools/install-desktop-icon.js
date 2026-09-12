'use strict';

/**
 * Puts a Win Duo shortcut on the desktop, with the app's own icon.
 *
 *   npm run shortcut
 *
 * The shortcut points straight at the Electron binary with the project directory
 * as its argument, rather than at `npm start`. Electron is a GUI application, so
 * launching it that way opens no console window; going through npm would leave a
 * black terminal sitting behind the tray icon.
 *
 * The icon has no file on disk normally - it is drawn in code - so this writes an
 * `.ico` next to the project first.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { writeIco, TARGET: ICON } = require('./make-ico');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

function main() {
  if (process.platform !== 'win32') {
    console.error('[win-duo] the desktop shortcut is Windows only');
    process.exit(1);
  }
  if (!fs.existsSync(ELECTRON)) {
    console.error(`[win-duo] electron is not installed; run npm install first (${ELECTRON})`);
    process.exit(1);
  }

  console.log(`[win-duo] wrote ${writeIco()}`);

  const desktop = path.join(os.homedir(), 'Desktop');
  if (!fs.existsSync(desktop)) {
    console.error(`[win-duo] no desktop directory at ${desktop}`);
    process.exit(1);
  }
  const link = path.join(desktop, 'Win Duo.lnk');

  // WScript.Shell is the only shortcut API Windows exposes without a native
  // module, so this goes through PowerShell.
  const script = `
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut(${JSON.stringify(link)})
$shortcut.TargetPath = ${JSON.stringify(ELECTRON)}
$shortcut.Arguments = '"' + ${JSON.stringify(ROOT)} + '"'
$shortcut.WorkingDirectory = ${JSON.stringify(ROOT)}
$shortcut.IconLocation = ${JSON.stringify(`${ICON},0`)}
$shortcut.Description = 'Win Duo - the iPhone Duo fold effect'
$shortcut.Save()
Write-Output 'ok'
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8' },
  );

  if (result.status !== 0 || !String(result.stdout).includes('ok')) {
    console.error('[win-duo] could not create the shortcut:');
    console.error(String(result.stderr || result.stdout).trim());
    process.exit(1);
  }

  console.log(`[win-duo] created ${link}`);
  console.log('[win-duo] press Ctrl+Alt+D once it is running to arm the effect');
}

main();
