'use strict';

const { screen } = require('electron');

const { captureDisplay } = require('./capture');

/**
 * Answers, precisely, which parts of the screen the overlay actually covers.
 *
 * The overlay is painted solid red, the screen is grabbed, and a grid of points
 * is sampled. Anything that is not red is something the overlay failed to cover,
 * which is how a taskbar ends up sitting un-warped across the bottom of a fold.
 * Brightness checks cannot see this: a leaking strip is small enough to hide
 * inside a band average.
 *
 *   .\node_modules\.bin\electron.cmd . --diagnose-cover
 */
async function diagnoseCover({ overlay, wait }) {
  const display = screen.getPrimaryDisplay();
  const win = await overlay.ensure();

  await wait(400);
  win.showInactive();
  await wait(200);
  win.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.size.width,
    height: display.size.height,
  });
  await wait(300);

  console.log(`display   ${display.size.width}x${display.size.height} at ${display.bounds.x},${display.bounds.y} (scale ${display.scaleFactor})`);
  console.log(`window    ${JSON.stringify(win.getBounds())}  alwaysOnTop=${win.isAlwaysOnTop()}`);
  console.log(`workArea  ${JSON.stringify(display.workArea)}`);

  // Paint the whole canvas an opaque red, straight through the same GL context
  // the effect uses.
  const painted = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('view');
    const gl = canvas.getContext('webgl2');
    if (!gl) return 'no gl';
    canvas.width = Math.round(innerWidth * devicePixelRatio);
    canvas.height = Math.round(innerHeight * devicePixelRatio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.flush();
    return canvas.width + 'x' + canvas.height;
  })()`);
  console.log(`painted   ${painted}`);

  await wait(500);
  const frame = await captureDisplay(display);
  if (!frame) {
    console.log('FAIL: could not grab the screen');
    return 1;
  }

  // Sampled as a fraction of the screen, so the report reads the same whatever
  // the panel resolution is.
  const columns = [0.02, 0.25, 0.5, 0.75, 0.98];
  const rows = [0.02, 0.2, 0.5, 0.8, 0.94, 0.98];
  const at = (fx, fy) => {
    const x = Math.min(frame.width - 1, Math.round(fx * frame.width));
    // Row 0 of the bitmap is the top of the screen.
    const y = Math.min(frame.height - 1, Math.round(fy * frame.height));
    const i = (y * frame.width + x) * 4;
    return { b: frame.bgra[i], g: frame.bgra[i + 1], r: frame.bgra[i + 2] };
  };

  const uncovered = [];
  console.log('coverage grid (red = covered), columns left to right:');
  for (const fy of rows) {
    const cells = columns.map((fx) => {
      const pixel = at(fx, fy);
      const red = pixel.r > 180 && pixel.g < 70 && pixel.b < 70;
      if (!red) uncovered.push({ fx, fy, pixel });
      return red ? ' ## ' : ' .. ';
    });
    console.log(`  y=${fy.toFixed(2).padStart(4)}  ${cells.join('')}`);
  }

  // The bottom of the screen in device pixels, which is where the taskbar is.
  console.log(`bottom row sample: ${JSON.stringify(at(0.5, 0.99))}`);

  if (uncovered.length) {
    console.log(`FAIL: ${uncovered.length} of ${rows.length * columns.length} points are not covered`);
    for (const point of uncovered.slice(0, 8)) {
      console.log(`  x=${point.fx} y=${point.fy} -> rgb(${point.pixel.r},${point.pixel.g},${point.pixel.b})`);
    }
    return 1;
  }

  console.log('PASS: the overlay covers the whole screen, edges and taskbar strip included.');
  return 0;
}

module.exports = { diagnoseCover };
