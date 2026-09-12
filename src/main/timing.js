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

  const probe = await win.webContents.executeJavaScript('window.__winDuoDebug()')
    .catch((error) => ({ error: error.message }));

  const display = screen.getPrimaryDisplay();
  console.log(`run wall clock:   ${total} ms`);
  console.log(`page build:       ${probe.timings ? probe.timings.buildMs : '?'} ms`);
  console.log(`bitmap bytes:     ${probe.timings ? probe.timings.bytes : '?'}`);
  console.log(`frames drawn:     ${probe.framesDrawn === undefined ? '?' : probe.framesDrawn}`);
  console.log(`page error:       ${probe.lastError || probe.error || 'none'}`);
  console.log(`display:          ${display.size.width}x${display.size.height} @${display.scaleFactor}x, canvas ${probe.canvas || '?'}`);

  const problems = [];
  if (probe.lastError || probe.error) problems.push('the overlay page reported an error');
  if (!probe.hasTexture) problems.push('the picture never reached the renderer');
  if (!probe.framesDrawn) problems.push('no frames were drawn');

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: the run completed and drew frames.');
  return 0;
}

module.exports = { timeOneRun };
