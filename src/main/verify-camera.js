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

  // The constraint helpers are pure, so strict selected-device constraints can
  // be checked here with no camera and no hardware.
  const helpers = await win.webContents.executeJavaScript(`(() => {
    const api = window.WinDuo.lidTracker;
    return {
      hasHelpers: typeof api.videoConstraints === 'function' && typeof api.cameraAttempts === 'function',
      empty: api.cameraAttempts(''),
      exact: api.cameraAttempts('cam-bogus'),
    };
  })()`);

  // A stream that opens but cannot start playing must not survive: the tracks
  // have to stop and open() has to report false, so the overlay falls back to
  // the sweep. The media APIs are stubbed for this one check, so no camera is
  // touched.
  const playFailure = await win.webContents.executeJavaScript(`(async () => {
    const mediaProto = window.MediaDevices && MediaDevices.prototype;
    if (!mediaProto || typeof mediaProto.getUserMedia !== 'function') return { skipped: true };
    const originalGet = mediaProto.getUserMedia;
    const originalPlay = HTMLMediaElement.prototype.play;
    let stopped = 0;
    const fakeStream = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
    mediaProto.getUserMedia = async () => fakeStream;
    if (navigator.mediaDevices.getUserMedia !== mediaProto.getUserMedia) {
      mediaProto.getUserMedia = originalGet;
      return { skipped: true };
    }
    HTMLMediaElement.prototype.play = async () => { throw new Error('play blocked'); };
    const tracker = new window.WinDuo.LidTracker({ deviceId: '' });
    let opened = null;
    let threw = false;
    try {
      opened = await tracker.open();
    } catch (error) {
      threw = true;
    } finally {
      mediaProto.getUserMedia = originalGet;
      HTMLMediaElement.prototype.play = originalPlay;
    }
    return {
      opened,
      threw,
      stopped,
      available: tracker.available,
      streamCleared: tracker.stream === null,
      videoCleared: tracker.video === null,
      hasNote: typeof tracker.note === 'string' && tracker.note.indexOf(': ') !== -1,
    };
  })()`);

  await wait(400);
  // Forced to 'auto' for this phase: the user is free to set 'click', which by
  // design never releases, and this phase is checking the release that happens
  // when the lid comes back on its own. The override is per run and is never
  // written back to their settings.
  console.log(`user releaseOn=${prefs.values.releaseOn}, this phase forces 'auto'`);
  // The bogus device id is the point: synthetic mode must ignore it rather than
  // try to open a camera that does not exist.
  await trigger({
    angleSource: 'camera',
    syntheticCamera: true,
    releaseOn: 'auto',
    cameraDeviceId: 'bogus-camera-id',
  });
  await wait(1000);

  const debug = () => win.webContents.executeJavaScript('window.__winDuoDebug()');
  const armed = await debug();
  // The hook only exists when the tracker took the synthetic branch, which is
  // the deterministic proof that the device id was ignored.
  const syntheticHook = await win.webContents.executeJavaScript('Boolean(window.__winDuoTrack)');
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

  // The pure constraint helpers: no saved device means one generic attempt;
  // a saved device means one exact attempt, with the existing ideal dimensions
  // and frame rate in both cases.
  if (!helpers.hasHelpers) problems.push('the camera constraint helpers are missing');
  const emptyAttempts = helpers.empty || [];
  const exactAttempts = helpers.exact || [];
  if (emptyAttempts.length !== 1 || emptyAttempts[0].deviceId) {
    problems.push('an empty device id did not produce a single generic attempt');
  }
  if (exactAttempts.length !== 1) {
    problems.push(`a saved device id produced ${exactAttempts.length} attempts, not 1`);
  } else if (!exactAttempts[0].deviceId || exactAttempts[0].deviceId.exact !== 'cam-bogus') {
    problems.push('the selected device did not use the exact saved camera');
  }
  for (const attempt of emptyAttempts.concat(exactAttempts)) {
    if (!attempt.width || attempt.width.ideal !== 640) problems.push('the width constraint was lost');
    if (!attempt.height || attempt.height.ideal !== 480) problems.push('the height constraint was lost');
    if (!attempt.frameRate || attempt.frameRate.ideal !== 30) problems.push('the frame rate constraint was lost');
  }
  if (!syntheticHook) problems.push('synthetic mode did not ignore the bogus device id');

  // The cleanup after a failed video.play(): tracks stopped, state cleared, and
  // a false return rather than a thrown rejection.
  if (playFailure && !playFailure.skipped) {
    if (playFailure.threw || playFailure.opened !== false) {
      problems.push('a rejected video.play() was not reported as a failed open');
    }
    if (playFailure.stopped !== 1) {
      problems.push('a rejected video.play() left the stream tracks running');
    }
    if (playFailure.available || !playFailure.streamCleared || !playFailure.videoCleared) {
      problems.push('a rejected video.play() did not clear the tracker stream');
    }
    if (!playFailure.hasNote) problems.push('a rejected video.play() did not set an error note');
  }
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

  // --- a run that ends while the camera is still opening --------------------
  // getUserMedia is delayed with a stub, the run is ended, and only then is the
  // stream handed back. The late result has to be closed instead of arming a run
  // that is already gone. The media APIs are stubbed for this check only, so no
  // real camera is opened.
  {
    const patched = await win.webContents.executeJavaScript(`(() => {
      const mediaProto = window.MediaDevices && MediaDevices.prototype;
      const streamProto = window.MediaStream && MediaStream.prototype;
      if (!mediaProto || typeof mediaProto.getUserMedia !== 'function') return { skipped: true };
      if (!streamProto || typeof streamProto.getTracks !== 'function') return { skipped: true };
      const originalGet = mediaProto.getUserMedia;
      const originalGetTracks = streamProto.getTracks;
      const originalPlay = HTMLMediaElement.prototype.play;
      const fakeGetTracks = () => [{ stop: () => { window.__winDuoCameraStops += 1; } }];
      const fakePlay = async () => {};
      window.__winDuoCameraStops = 0;
      window.__winDuoGetUserMediaCalls = 0;
      window.__winDuoResolveCamera = null;
      window.__winDuoOriginalGet = originalGet;
      window.__winDuoOriginalGetTracks = originalGetTracks;
      window.__winDuoOriginalPlay = originalPlay;
      mediaProto.getUserMedia = () => {
        window.__winDuoGetUserMediaCalls += 1;
        return new Promise((resolve) => {
          window.__winDuoResolveCamera = () => resolve(new MediaStream());
        });
      };
      streamProto.getTracks = fakeGetTracks;
      HTMLMediaElement.prototype.play = fakePlay;
      const applied = navigator.mediaDevices.getUserMedia === mediaProto.getUserMedia
        && streamProto.getTracks === fakeGetTracks
        && HTMLMediaElement.prototype.play === fakePlay;
      if (!applied) {
        mediaProto.getUserMedia = originalGet;
        streamProto.getTracks = originalGetTracks;
        HTMLMediaElement.prototype.play = originalPlay;
        return { skipped: true };
      }
      return { skipped: false };
    })()`);

    if (patched && patched.skipped) {
      console.log('delayed open: skipped (media APIs unavailable)');
    } else {
      try {
        const idleDeadline = Date.now() + 5000;
        while (isPlaying() && Date.now() < idleDeadline) await wait(25);

        await trigger({ angleSource: 'camera', syntheticCamera: false, releaseOn: 'auto' });

        let calls = 0;
        const callDeadline = Date.now() + 4000;
        while (Date.now() < callDeadline) {
          calls = await win.webContents.executeJavaScript('window.__winDuoGetUserMediaCalls');
          if (calls > 0) break;
          await wait(25);
        }

        // End the run while open() is still waiting on getUserMedia.
        overlay.requestExit();
        const endDeadline = Date.now() + 8000;
        while (isPlaying() && Date.now() < endDeadline) await wait(25);
        const endedBeforeResolve = !isPlaying();

        // Now let the camera open complete, late.
        await win.webContents.executeJavaScript('window.__winDuoResolveCamera && window.__winDuoResolveCamera()');
        await wait(150);
        const stops = await win.webContents.executeJavaScript('window.__winDuoCameraStops');
        console.log(`delayed open: calls=${calls} endedBeforeResolve=${endedBeforeResolve} stops=${stops} hidden=${!win.isVisible()}`);

        if (calls < 1) problems.push('the delayed-open test never reached getUserMedia');
        if (!endedBeforeResolve) problems.push('the run did not end before the delayed camera open resolved');
        if (stops < 1) problems.push('a camera stream survived a run that ended during open()');
      } finally {
        await win.webContents.executeJavaScript(`(() => {
          if (window.__winDuoOriginalGet && window.MediaDevices) {
            MediaDevices.prototype.getUserMedia = window.__winDuoOriginalGet;
          }
          if (window.__winDuoOriginalGetTracks && window.MediaStream) {
            MediaStream.prototype.getTracks = window.__winDuoOriginalGetTracks;
          }
          if (window.__winDuoOriginalPlay) {
            HTMLMediaElement.prototype.play = window.__winDuoOriginalPlay;
          }
          window.__winDuoResolveCamera = null;
          return true;
        })()`);
      }
    }
  }

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log('PASS: and Escape ends a run, in both release modes.');
  return 0;
}

module.exports = { verifyCameraTracking };
