'use strict';

/**
 * End-to-end check of the live camera path, with no camera and no hand.
 *
 * The tracker is fed a generated scene instead of the webcam, and the harness
 * moves that scene the way a closing lid would. Everything else - arming, the
 * travel-to-angle mapping, the fade, the release, the report the calibration
 * reads - is the real code path.
 *
 * Without this there would be no way to test live tracking automatically: the
 * picture deliberately stays invisible until the lid actually moves, so a
 * screen-brightness check like the one in verify.js would see nothing.
 *
 *   .\node_modules\.bin\electron.cmd . --verify-camera
 */
async function verifyCameraTracking({ trigger, overlay, wait, isPlaying, prefs, getLastReport }) {
  const win = await overlay.ensure();
  const fullTravel = Number(prefs.values.fullTravel) || 170;
  const restAngle = Number(prefs.values.restAngle) || 105;

  await wait(400);
  // Forced to 'auto' for this phase: the user is free to set 'click', which by
  // design never releases, and this phase is checking the release that happens
  // when the lid comes back on its own. The override is per run and is never
  // written back to their settings.
  console.log(`user releaseOn=${prefs.values.releaseOn}, this phase forces 'auto'`);
  await trigger({ angleSource: 'camera', syntheticCamera: true, releaseOn: 'auto' });
  await wait(1000);

  const debug = () => win.webContents.executeJavaScript('window.__winDuoDebug()');
  const armed = await debug();
  console.log(`armed   fullTravel=${fullTravel} restAngle=${restAngle}`);
  console.log(`        ${JSON.stringify(armed.state)}`);

  // Move the scene the way a deliberate close does: a couple of rows per frame,
  // which stays inside the tracker's search range. 34 frames x 2 rows = 68 rows,
  // about 40% of a complete close.
  const drive = (steps, pixelsPerStep) => win.webContents.executeJavaScript(`(async () => {
    const hook = window.__winDuoTrack;
    if (!hook) return 'no test hook';
    for (let i = 0; i < ${steps}; i += 1) {
      hook.step(${pixelsPerStep});
      await new Promise((r) => requestAnimationFrame(r));
    }
    return 'ok';
  })()`);

  const closedDrive = await drive(34, 8);
  await wait(800);
  const closing = await debug();
  console.log(`closing ${JSON.stringify(closing.state)}`);

  const openDrive = await drive(34, -8);
  await wait(300);
  const reopening = await debug();
  console.log(`reopen  ${JSON.stringify(reopening.state)}`);

  const deadline = Date.now() + 10000;
  while (isPlaying() && Date.now() < deadline) await wait(100);
  const hidden = !win.isVisible();
  const report = getLastReport();
  console.log(`report  ${JSON.stringify(report)}`);
  console.log(`overlay hidden after the run: ${hidden}`);

  const problems = [];
  if (closedDrive !== 'ok' || openDrive !== 'ok') problems.push('the test hook was missing');
  if (!armed.state || armed.state.mode !== 'camera') problems.push('the run did not arm in camera mode');
  if (armed.state && armed.state.opacity > 0.1) problems.push('the picture was visible before the lid moved');
  if (!closing.state || !closing.state.engaged) problems.push('the lid movement was not detected');
  if (closing.state && !(closing.state.progress > 0.15)) problems.push(`closing only reached progress ${closing.state.progress}`);
  if (closing.state && !(closing.state.angle < restAngle - 5)) problems.push(`the angle did not drop (${closing.state && closing.state.angle})`);
  if (closing.state && closing.state.opacity < 0.9) problems.push('the picture never became visible');
  if (!report || report.reason !== 'back at rest') problems.push(`the release reason was ${report && report.reason}`);
  if (report && !(report.maxPeak > fullTravel * 0.15)) problems.push(`the peak travel was not reported (${report && report.maxPeak})`);
  if (report && !(report.peakTravel < report.maxPeak * 0.5)) problems.push('the fold did not follow back down on reopen');
  if (!hidden) problems.push('the overlay stayed up');

  // The picture has to travel back down, not step back down. An earlier ratchet
  // froze the fold and then released it in ~20% chunks, which read as the blur
  // snapping. The drive moves 2 rows per frame, so at 100 ms sampling a smooth
  // reopen changes by far less than this.
  if (report && report.trace && report.trace.length > 4) {
    let worstStep = 0;
    let worstAt = 0;
    for (let i = 1; i < report.trace.length; i += 1) {
      const step = Math.abs(report.trace[i].peak - report.trace[i - 1].peak);
      if (step > worstStep) { worstStep = step; worstAt = report.trace[i].t; }
    }
    console.log(`largest travel step between 100 ms samples: ${worstStep.toFixed(1)} rows at ${worstAt} ms`);
    if (worstStep > 25) problems.push(`the travel steps by ${worstStep.toFixed(1)} rows at once`);
  }

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: arming, tracking, the fold following the lid, the release and the report all worked.');

  // --- clicking ends a run -------------------------------------------------
  const clickRun = async (overrides, settleMs) => {
    const started = Date.now();
    await trigger(overrides);
    await wait(1000);
    await drive(20, 8);
    await wait(settleMs);
    const beforeClick = await debug();
    if (settleMs > 0) {
      console.log(`  after ${settleMs} ms of holding still: engaged=${beforeClick.state && beforeClick.state.engaged} releasing=${beforeClick.state && beforeClick.state.releasing} progress=${beforeClick.state && beforeClick.state.progress}`);
    }
    await win.webContents.executeJavaScript(
      "document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true",
    );
    const clickAt = Date.now();
    const deadline2 = Date.now() + 8000;
    while (isPlaying() && Date.now() < deadline2) await wait(15);
    return { beforeClick, report: getLastReport(), latency: Date.now() - clickAt };
  };

  console.log('--- a click should end a run on its own ---');
  const clicked = await clickRun({ angleSource: 'camera', syntheticCamera: true }, 400);
  console.log(`  reason=${clicked.report && clicked.report.reason}  hidden=${!win.isVisible()}  click to gone: ${clicked.latency} ms`);
  if (!clicked.report || clicked.report.reason !== 'clicked') {
    problems.push(`a click did not end the run (reason ${clicked.report && clicked.report.reason})`);
  }
  // The ease back to flat and the fade are serial, so this is the number that
  // decides whether clicking feels like it did anything. It used to be around
  // 700 ms.
  if (clicked.latency > 450) problems.push(`clicking took ${clicked.latency} ms to clear the screen`);

  console.log('--- "only when I click" should not time out ---');
  const held = await clickRun(
    { angleSource: 'camera', syntheticCamera: true, releaseOn: 'click', idleReleaseMs: 1500 },
    3200,
  );
  const stillUp = held.beforeClick.state && held.beforeClick.state.engaged && !held.beforeClick.state.releasing;
  console.log(`  still up after 3.2 s against a 1.5 s idle timeout: ${stillUp}`);
  if (!stillUp) problems.push('the run timed out even though it was set to end only on a click');
  if (!held.report || held.report.reason !== 'clicked') {
    problems.push(`the click after holding did not end the run (reason ${held.report && held.report.reason})`);
  }

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: and a click ends a run, in both release modes.');
  return 0;
}

module.exports = { verifyCameraTracking };
