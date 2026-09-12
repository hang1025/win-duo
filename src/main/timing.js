'use strict';

const { app, globalShortcut, screen } = require('electron');

/**
 * Prints the timing marks for one clean run, with nothing else competing for the
 * main process.
 *
 *   .\node_modules\.bin\electron.cmd . --timing
 *
 * The verify harness keeps grabbing the screen to watch the effect, and those
 * grabs block the main process hard enough to distort the numbers. This runs the
 * real path on its own, so the figures are the ones a user actually gets.
 *
 * Set WIN_DUO_DEBUG=1 to also see the per-stage marks.
 */

async function timeOneRun({ trigger, overlay, wait, isPlaying }) {
  await overlay.ensure();
  const win = overlay.win;

  // Let the window and the page settle before measuring.
  await wait(1500);

  const started = Date.now();
  await trigger();

  const deadline = Date.now() + 10000;
  while (isPlaying() && Date.now() < deadline) await wait(50);
  const total = Date.now() - started;

  let probe = null;
  try {
    probe = await win.webContents.executeJavaScript('window.__winDuoDebug()');
  } catch (error) {
    probe = { error: error.message };
  }

  const points = Math.round((probe && probe.canvas ? probe.canvas : '0x0').split('x')[0] * 1);
  console.log(`run wall clock:            ${total} ms`);
  console.log(`page build:                ${probe && probe.timings ? probe.timings.buildMs : '?'} ms`);
  console.log(`frames drawn:              ${probe ? probe.framesDrawn : '?'}`);
  console.log(`last page error:           ${probe ? probe.lastError : '?'}`);
  console.log(`display:                   ${screen.getPrimaryDisplay().size.width}x${screen.getPrimaryDisplay().size.height} @${screen.getPrimaryDisplay().scaleFactor}x (canvas ${points}px wide)`);
  console.log('renderer marks are logged above with WIN_DUO_DEBUG=1; the gap between');
  console.log('"grabbing the screen" and "first-frame" is what the user waits for.');
  return 0;
}

module.exports = { timeOneRun };
