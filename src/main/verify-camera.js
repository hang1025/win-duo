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
  await trigger({ angleSource: 'camera', syntheticCamera: true });
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
  if (report && !(report.peakTravel > fullTravel * 0.15)) problems.push(`the peak travel was not reported (${report && report.peakTravel})`);
  if (!hidden) problems.push('the overlay stayed up');

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: arming, tracking, the fold following the lid, the release and the report all worked.');
  return 0;
}

module.exports = { verifyCameraTracking };
