'use strict';

/**
 * Runs the sensor inventory probe on its own and prints the raw protocol lines,
 * so the probe can be checked without launching the whole recon window.
 *
 *   node tools/lid-recon/probe-sensors.js
 */
const { spawn } = require('child_process');
const { SENSOR_INVENTORY, encodeCommand } = require('./scripts');

const POWERSHELL = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

const child = spawn(
  POWERSHELL,
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(SENSOR_INVENTORY)],
  { windowsHide: true },
);

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });
child.on('close', (code) => {
  console.log(out.trim());
  if (err.trim()) console.log('--- stderr ---\n' + err.trim());
  const present = out.split(/\r?\n/).filter((l) => l.includes('|PRESENT|'));
  const absent = out.split(/\r?\n/).filter((l) => l.includes('|ABSENT')).length;
  console.log(`--- present: ${present.length}, absent: ${absent}, exit ${code} ---`);
  process.exit(0);
});
