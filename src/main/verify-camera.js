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
async function verifyCameraTracking({
  trigger, overlay, wait, isPlaying, prefs, getLastReport, registerExitKey,
}) {
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
  // snapping.
  //
  // The bound is measured from the run itself rather than hard coded: the drive
  // moves as fast as the frame rate allows, so a fixed number sits right on top
  // of the legitimate motion and fails at random. The drive is symmetric, so a
  // reopen that never outpaces the close is a reopen that is following.
  if (report && report.trace && report.trace.length > 4) {
    let closeStep = 0;
    let reopenStep = 0;
    let reopenAt = 0;
    for (let i = 1; i < report.trace.length; i += 1) {
      const step = report.trace[i].peak - report.trace[i - 1].peak;
      if (step > closeStep) closeStep = step;
      if (-step > reopenStep) { reopenStep = -step; reopenAt = report.trace[i].t; }
    }
    console.log(`largest travel step: closing ${closeStep.toFixed(1)} rows, reopening ${reopenStep.toFixed(1)} rows at ${reopenAt} ms`);
    if (reopenStep > closeStep + 2) {
      problems.push(`the reopen steps by ${reopenStep.toFixed(1)} rows against a closing rate of ${closeStep.toFixed(1)}`);
    }
  }

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: arming, tracking, the fold following the lid, the release and the report all worked.');

  // --- the exit key ends a run ---------------------------------------------
  const exitRun = async (overrides, settleMs) => {
    await trigger(overrides);
    await wait(1000);
    await drive(20, 8);
    await wait(settleMs);
    const beforeExit = await debug();
    if (settleMs > 0) {
      console.log(`  after ${settleMs} ms of holding still: engaged=${beforeExit.state && beforeExit.state.engaged} releasing=${beforeExit.state && beforeExit.state.releasing} progress=${beforeExit.state && beforeExit.state.progress}`);
    }
    // The same path the registered key takes: main asks the page to end the run.
    // The key press itself cannot be synthesised, but everything downstream of
    // it can, and the registration is reported separately.
    overlay.requestExit();
    const exitAt = Date.now();
    const deadline2 = Date.now() + 8000;
    while (isPlaying() && Date.now() < deadline2) await wait(15);
    return { beforeExit, report: getLastReport(), latency: Date.now() - exitAt };
  };

  console.log(`exit key registered while a run is up: ${registerExitKey()}`);
  console.log('--- Escape should end a run on its own ---');
  const exited = await exitRun({ angleSource: 'camera', syntheticCamera: true }, 400);
  console.log(`  reason=${exited.report && exited.report.reason}  hidden=${!win.isVisible()}  key to gone: ${exited.latency} ms`);
  if (!exited.report || exited.report.reason !== 'escape') {
    problems.push(`the exit key did not end the run (reason ${exited.report && exited.report.reason})`);
  }
  // The ease back to flat and the fade are serial, so this is the number that
  // decides whether ending a run by hand feels like it did anything. It used to
  // be around 700 ms.
  if (exited.latency > 450) problems.push(`ending a run took ${exited.latency} ms to clear the screen`);

  console.log('--- "only when I press Esc" should not time out ---');
  const held = await exitRun(
    { angleSource: 'camera', syntheticCamera: true, releaseOn: 'key', idleReleaseMs: 1500 },
    3200,
  );
  const stillUp = held.beforeExit.state && held.beforeExit.state.engaged && !held.beforeExit.state.releasing;
  console.log(`  still up after 3.2 s against a 1.5 s idle timeout: ${stillUp}`);
  if (!stillUp) problems.push('the run timed out even though it was set to end only on the exit key');
  if (!held.report || held.report.reason !== 'escape') {
    problems.push(`the exit key after holding did not end the run (reason ${held.report && held.report.reason})`);
  }

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: and Escape ends a run, in both release modes.');
  return 0;
}

module.exports = { verifyCameraTracking };
