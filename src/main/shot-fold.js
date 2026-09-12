'use strict';

const fs = require('fs');
const path = require('path');
const { nativeImage, screen } = require('electron');

const { captureDisplay } = require('./capture');

/**
 * Grabs the actual screen at a set of held fold levels, so the effect can be
 * looked at the way the user sees it.
 *
 * Everything else in this project tests properties. This tests the picture. A
 * fold that is obviously wrong - or one that lets the untouched desktop show
 * through where the picture has contracted away from the edge of the screen -
 * passes every numeric check and still looks wrong to a person.
 *
 * The fold is driven by the synthetic camera and held at each level rather than
 * caught mid-sweep: a screen grab costs most of a second and starves the render
 * loop, so frames caught during a live sweep do not correspond to the angles
 * they claim to.
 *
 *   .\node_modules\.bin\electron.cmd . --shot-fold
 */
const LEVELS = [0, 0.12, 0.3, 0.5, 0.75, 1];

async function shotFold({ trigger, overlay, wait, prefs }) {
  const display = screen.getPrimaryDisplay();
  const outDir = path.join(__dirname, '..', '..', 'selftest-output', 'screen');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const win = await overlay.ensure();
  await wait(400);
  await trigger({ angleSource: 'camera', syntheticCamera: true });
  await wait(1200);

  const full = Number(prefs.values.fullTravel) || 170;
  // The synthetic scene moves one canvas row for every four source pixels.
  const sourcePixelsPerRow = 4;

  const step = (targetOffset) => win.webContents.executeJavaScript(`(async () => {
    const hook = window.__winDuoTrack;
    if (!hook) return { error: 'no test hook' };
    const stepPx = ${sourcePixelsPerRow * 2};
    // Counted, not condition-on-offset: an earlier version looped on
    // \`hook.offset\`, which the hook did not expose, so the comparison was
    // against undefined and the loop ran zero times while reporting success.
    const steps = Math.ceil((${targetOffset} - hook.offset) / stepPx);
    for (let i = 0; i < steps; i += 1) {
      hook.step(stepPx);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { offset: hook.offset, steps, debug: window.__winDuoDebug().state };
  })()`);

  const files = [];
  for (const level of LEVELS) {
    // eslint-disable-next-line no-await-in-loop
    const stepped = await step(Math.round(full * level * sourcePixelsPerRow));
    // Let the spring settle before looking: the capture itself perturbs the
    // frame rate enough that anything caught mid-motion is misleading.
    // eslint-disable-next-line no-await-in-loop
    await wait(900);

    // eslint-disable-next-line no-await-in-loop
    const state = await win.webContents.executeJavaScript('window.__winDuoDebug()');
    // eslint-disable-next-line no-await-in-loop
    const frame = await captureDisplay(display);
    if (!frame) continue;

    const image = nativeImage.createFromBitmap(frame.bgra, {
      width: frame.width,
      height: frame.height,
      scaleFactor: 1,
    });
    const percent = String(Math.round(level * 100)).padStart(3, '0');
    const file = path.join(outDir, `fold-${percent}.png`);
    fs.writeFileSync(file, image.toPNG());
    files.push(file);

    const s = state.state || {};
    console.log(
      `fold ${percent}%  stepped=${JSON.stringify(stepped)}  mode=${s.mode}  `
      + `angle=${s.angle}  progress=${s.progress}  travel=${s.travel}  `
      + `opacity=${s.opacity}  q${s.quality} ${s.strips}/8`,
    );

    // Ask the shader directly what it does near the bottom of the screen, where
    // the taskbar lives. If the picture covers it, no live taskbar can show
    // through, whatever a photograph appears to suggest.
    // eslint-disable-next-line no-await-in-loop
    const probes = await win.webContents.executeJavaScript(`(() => {
      const h = innerHeight;
      const at = (y) => window.__winDuoProbe(innerWidth / 2, y);
      return { bottom5: at(5), bottom40: at(40), bottom80: at(80), top5: at(h - 5) };
    })()`);
    for (const [where, probe] of Object.entries(probes)) {
      if (!probe) { console.log(`    ${where}: no probe`); continue; }
      console.log(`    ${where}: covered=${probe.covered} unit=[${probe.unit}] picture=[${probe.picturePoint}]`);
    }
  }

  console.log(`[win-duo] wrote ${files.length} screen frames to ${outDir}`);
  return 0;
}

module.exports = { shotFold };
