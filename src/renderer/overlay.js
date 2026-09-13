/*
 * Win Duo - the overlay renderer.
 *
 * One full-screen pass per frame: the picture is warped by the inverse of the
 * projective map, blurred by picking a mip level per pixel, and dimmed by
 * height. See lib/shader.js for the maths and src/main/defaults.js for the
 * tuning.
 */
(function () {
  'use strict';

  const NS = window.WinDuo;
  const params = new URLSearchParams(window.location.search);
  const selfTest = params.get('selftest') === '1';

  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    // Only the self test needs to read the drawing buffer back.
    preserveDrawingBuffer: selfTest,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    document.body.textContent = 'WebGL2 is not available.';
    return;
  }

  // --- Program ------------------------------------------------------------

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'shader failed to compile');
    }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, NS.SHADER.vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, NS.SHADER.fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program failed to link');
  }
  gl.useProgram(program);

  const UNIFORMS = [
    'uScreenToPicture', 'uScreenSize', 'uPaddedOrigin', 'uPaddedSize', 'uPixelScale',
    'uMaxRadius', 'uBlurStrength', 'uBlurFloor', 'uMaxLevel', 'uDimHingeFloor',
    'uDimStrength', 'uDimReach', 'uMaxDim', 'uOpacity', 'uPicture',
  ];
  const U = {};
  for (const name of UNIFORMS) U[name] = gl.getUniformLocation(program, name);

  // WebGL2 needs a vertex array bound even when the vertex shader reads nothing
  // but gl_VertexID.
  gl.bindVertexArray(gl.createVertexArray());
  gl.uniform1i(U.uPicture, 0);

  // --- Picture ------------------------------------------------------------

  const padded = document.createElement('canvas');
  const paddedCtx = padded.getContext('2d', { willReadFrequently: false });
  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d', { willReadFrequently: false });

  let texture = null;

  /** BGRA bytes to RGBA, four pixels per iteration. */
  function bgraToRgba(bgra, width, height) {
    const count = width * height;
    const bytes = bgra.byteOffset % 4 === 0 ? bgra : bgra.slice();
    const source = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    const out = new Uint8ClampedArray(count * 4);
    const target = new Uint32Array(out.buffer);
    for (let i = 0; i < count; i += 1) {
      const value = source[i];
      target[i] = (value & 0xff00ff00) | ((value & 0xff) << 16) | ((value >>> 16) & 0xff);
    }
    return out;
  }

  /**
   * A picture for the self test: a grid, a centre mark, and labelled edges, so
   * a dump makes orientation and warp obvious without a screen to look at.
   */
  function drawTestPattern(ctx, width, height) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#10233f');
    gradient.addColorStop(1, '#3a1020');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.lineWidth = 2;
    for (let x = 0; x <= width; x += 80) {
      ctx.strokeStyle = x % 400 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 80) {
      ctx.strokeStyle = y % 400 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Edge bars: red on top, green at the bottom. A vertical flip swaps them.
    ctx.fillStyle = '#ff2d2d';
    ctx.fillRect(0, 0, width, 14);
    ctx.fillStyle = '#2dff6a';
    ctx.fillRect(0, height - 14, width, 14);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.16, 0, Math.PI * 2);
    ctx.stroke();

    const size = Math.round(Math.min(width, height) * 0.07);
    ctx.font = `bold ${size}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('TOP', width / 2, size * 1.4);
    ctx.fillText('BOTTOM', width / 2, height - size * 1.4);
    ctx.fillText('L', size * 1.5, height / 2);
    ctx.fillText('R', width - size * 1.5, height / 2);
  }

  /**
   * Lays the picture on a black margin, uploads it, and rebuilds the pyramid.
   * The margin must be wider than the largest blur radius so the blur reaches
   * real black on every side; that is what keeps the picture edge from showing a
   * hard line.
   */
  function buildPicture(options) {
    const { width, height, paddingPoints, pixelScale } = options;
    const padPx = Math.round(paddingPoints * pixelScale);
    const paddedWidth = width + padPx * 2;
    const paddedHeight = height + padPx * 2;

    padded.width = paddedWidth;
    padded.height = paddedHeight;
    paddedCtx.fillStyle = '#000';
    paddedCtx.fillRect(0, 0, paddedWidth, paddedHeight);

    if (options.sourceCanvas) {
      paddedCtx.drawImage(options.sourceCanvas, padPx, padPx, width, height);
    } else {
      scratch.width = width;
      scratch.height = height;
      scratchCtx.putImageData(
        new ImageData(bgraToRgba(options.bgra, width, height), width, height),
        0,
        0,
      );
      paddedCtx.drawImage(scratch, padPx, padPx);
    }

    if (texture) gl.deleteTexture(texture);
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, padded);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return {
      maxLevel: Math.floor(Math.log2(Math.max(paddedWidth, paddedHeight))),
      paddedWidth,
      paddedHeight,
    };
  }

  // --- Frame --------------------------------------------------------------

  let state = null;
  let rafId = 0;
  let framesDrawn = 0;
  let lastError = null;
  let timings = null;
  /** The webcam tracker, in camera mode only. */
  let tracker = null;
  /** Spring that smooths the tracked progress, so sensor noise cannot jitter it. */
  let trackerSpring = null;

  // --- Persistent monitor -------------------------------------------------
  // One camera stream, owned by this page, kept open between runs when the
  // user turns the monitor on. A close crossing the relative trigger asks the
  // main process to start a run; that run reuses this exact tracker instead of
  // opening a second stream. Sampling uses a timer, never requestAnimationFrame:
  // the window is hidden between runs and rAF would simply not fire.
  const MONITOR_INTERVAL_MS = 66;
  // How long a run will wait for the monitor's camera to finish opening before
  // giving up and using the scripted sweep, rather than opening a second stream.
  const MONITOR_ADOPT_WAIT_MS = 1200;
  const monitor = {
    active: false,
    ready: false,
    paused: false,
    /** A crossing was reported and the main process has not answered yet. */
    pending: false,
    tracker: null,
    state: null,
    timer: 0,
    /** Bumped whenever the stream is replaced, so a late open() is dropped. */
    token: 0,
    /** The newest monitor decision from the main process; older ones are ignored. */
    generation: 0,
    /** True while a camera open is in flight, so a same-device start does not repeat it. */
    opening: false,
    /** Opens are serialized here, so only one getUserMedia is ever outstanding. */
    openChain: Promise.resolve(),
    /** Set when a camera change arrives while a run owns the stream. */
    reopenAfterRun: false,
    config: null,
    lastTravel: 0,
    direction: 1,
    runOwnsTracker: false,
    closeAfterRun: false,
    crossings: 0,
    reusedLastRun: false,
  };

  const hintElement = document.getElementById('hint');
  const readoutElement = document.getElementById('readout');
  let hintTimer = 0;

  function showHint(text, ms = 4000) {
    if (!hintElement) return;
    hintElement.textContent = text;
    hintElement.style.opacity = '1';
    if (hintTimer) window.clearTimeout(hintTimer);
    if (ms > 0) hintTimer = window.setTimeout(() => { hintElement.style.opacity = '0'; }, ms);
  }

  function hideHint() {
    if (!hintElement) return;
    if (hintTimer) window.clearTimeout(hintTimer);
    hintElement.style.opacity = '0';
  }

  function updateReadout() {
    if (!readoutElement || !state) return;
    if (!state.settings.showAngleReadout) {
      readoutElement.style.opacity = '0';
      return;
    }
    readoutElement.style.opacity = '1';
    if (state.mode === 'camera') {
      const gate = state.engaged
        ? (state.settings.releaseOn === 'auto' ? '按 Esc 退出' : '按 Esc 退出 · 不自动结束')
        : '待命 · 按 Esc 取消';
      readoutElement.textContent = [
        `角度 ${state.angle.toFixed(1)}°`,
        `行程 ${state.peakTravel.toFixed(0)}/${Number(state.settings.fullTravel).toFixed(0)}`,
        `${(state.progress * 100).toFixed(0)}%`,
        `${Math.round(state.rate || 0)}fps`,
        `q${state.quality.toFixed(2)} ${state.usedStrips}/8`,
        state.releasing ? '收尾中' : gate,
      ].join('  ·  ');
    } else {
      readoutElement.textContent = `脚本动画  ${state.angle.toFixed(1)}°`;
    }
  }

  // The main process can ask what the overlay is doing, which is the only way to
  // tell "the window is up but drawing nothing" from "the window never showed".
  window.__winDuoDebug = () => ({
    hasBridge: Boolean(window.winDuoBridge),
    hasTexture: Boolean(texture),
    framesDrawn,
    lastError,
    timings,
    canvas: `${canvas.width}x${canvas.height} css ${canvas.style.width}x${canvas.style.height}`,
    state: state
      ? {
        mode: state.mode,
        phase: state.phase,
        opacity: Number(state.opacity.toFixed(3)),
        angle: Number(state.angle.toFixed(2)),
        progress: Number(state.progress.toFixed(3)),
        travel: Number(state.travel.toFixed(2)),
        direction: state.direction,
        quality: Number(state.quality.toFixed(2)),
        strips: state.usedStrips,
        engaged: state.engaged,
        releasing: state.releasing,
        peakTravel: Number(state.peakTravel.toFixed(2)),
        gate: state.gate,
      }
      : null,
  });

  function render(angle, opacity) {
    const settings = state.settings;
    const corners = NS.geometry.corners({
      startAngle: state.startAngle,
      currentAngle: angle,
      viewingDistance: settings.viewingDistance,
      recession: settings.recession,
      maxSeparationDegrees: settings.maxSeparationDegrees,
      width: state.screenWidth,
      height: state.screenHeight,
    });
    const inverse = NS.invert3(NS.rectToQuad(state.screenWidth, state.screenHeight, corners));
    if (!inverse) return;
    // Kept so the probe below can answer "what does the shader do at this
    // screen point" without guessing from a photograph.
    state.lastInverse = inverse;

    // Only the blur and the dimming saturate: the geometry takes the angle
    // itself, so the picture keeps moving all the way to the shut angle.
    const progress = NS.gradient.clamp01(
      (state.startAngle - angle) / Math.max(settings.blurSpan, 1),
    );

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.uniformMatrix3fv(U.uScreenToPicture, false, new Float32Array(inverse));
    gl.uniform2f(U.uScreenSize, state.screenWidth, state.screenHeight);
    gl.uniform2f(U.uPaddedOrigin, -state.paddingPoints, -state.paddingPoints);
    gl.uniform2f(
      U.uPaddedSize,
      state.screenWidth + 2 * state.paddingPoints,
      state.screenHeight + 2 * state.paddingPoints,
    );
    gl.uniform1f(U.uPixelScale, state.pixelScale);
    gl.uniform1f(U.uMaxRadius, settings.maxBlurRadius * state.pixelScale);
    gl.uniform1f(
      U.uBlurStrength,
      NS.gradient.blurStrength(progress, settings.blurCurve),
    );
    gl.uniform1f(U.uBlurFloor, settings.blurEvenness);
    gl.uniform1f(U.uMaxLevel, state.maxLevel);
    gl.uniform1f(U.uDimHingeFloor, settings.dimHingeFloor);
    gl.uniform1f(
      U.uDimStrength,
      NS.gradient.dimStrength(progress, settings.dimCurve),
    );
    gl.uniform1f(U.uDimReach, settings.dimReach);
    gl.uniform1f(U.uMaxDim, settings.maxDim);
    gl.uniform1f(U.uOpacity, opacity);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The scripted angle for this frame, or null once the sweep is over. */
  function scriptedAngle(now) {
    const settings = state.settings;
    const elapsed = (now - state.t0) / 1000;
    const closing = settings.sweepClosing;
    const hold = settings.sweepHold;
    const opening = settings.sweepOpening;
    const { openAngle, shutAngle } = state;

    if (elapsed < closing) {
      return openAngle + (shutAngle - openAngle) * (elapsed / closing);
    }
    if (elapsed < closing + hold) return shutAngle;
    if (elapsed < closing + hold + opening) {
      return shutAngle + (openAngle - shutAngle) * ((elapsed - closing - hold) / opening);
    }
    return null;
  }

  /** The scripted mode: the sweep plays out on its own. */
  function updateFromSweep(dt, now) {
    const scripted = scriptedAngle(now);
    if (scripted === null && state.phase === 'sweep') state.phase = 'settle';
    state.spring.advance(scripted === null ? state.openAngle : scripted, dt, state.settings.springFrequency);

    if (state.phase === 'settle' && Math.abs(state.spring.value - state.openAngle) < 0.05) {
      // The picture is flat again, so it matches the screen behind it exactly
      // and the fade out has nothing to give away.
      state.phase = 'fadeout';
      state.fadingOut = true;
      state.spring.reset(state.openAngle);
    }

    state.angle = state.spring.value;
    state.progress = NS.gradient.clamp01(
      (state.startAngle - state.angle) / Math.max(state.settings.blurSpan, 1),
    );
  }

  /**
   * The live mode: the angle comes from the webcam tracker.
   *
   * The value the tracker reports is accumulated image travel, not degrees. It
   * is scaled by `fullTravel`, the travel a complete close produces, which is
   * re-learned from every complete close because it depends on the camera, the
   * room and where the user sits.
   */
  function updateFromCamera(dt, now) {
    const settings = state.settings;

    const sampled = tracker ? tracker.sample() : null;
    if (sampled !== null) {
      state.travel = sampled;
      state.quality = tracker.quality;
      state.usedStrips = tracker.usedStrips;
      state.rate = tracker.rate();
    }

    const full = Math.max(1, Number(settings.fullTravel) || 170);
    const engageRows = full * settings.engageFraction;

    // Which way the scene slides when the lid closes depends on how the camera
    // is mounted and how the user sits, so the sign is latched from the largest
    // excursion rather than assumed.
    const magnitude = Math.abs(state.travel);
    if (magnitude > engageRows && magnitude > state.peakMagnitude) {
      state.peakMagnitude = magnitude;
      state.direction = Math.sign(state.travel) || state.direction;
    }
    const closingTravel = state.travel * state.direction;

    // Closing follows instantly. Opening follows through a first-order lag, so
    // tracker noise, and the brief reversal part way through a close when the
    // camera stops looking at the room and starts looking at the keyboard,
    // cannot move the picture - while a real unfold glides.
    //
    // A hold-then-release ratchet was tried here first and was worse: it froze
    // the picture and then released about a fifth of the travel in one step,
    // roughly twice a second, which read as the blur snapping rather than
    // travelling up the screen.
    if (closingTravel >= state.peakTravel) {
      state.peakTravel = closingTravel;
    } else {
      const follow = Math.min(1, dt / Math.max(0.02, Number(settings.releaseFollowSeconds) || 0.25));
      state.peakTravel += (closingTravel - state.peakTravel) * follow;
    }
    state.maxPeak = Math.max(state.maxPeak, state.peakTravel);

    if (Math.abs(closingTravel - state.lastIdleTravel) > engageRows) {
      state.lastIdleTravel = closingTravel;
      state.lastMoveAt = now;
    }

    if (!state.engaged && state.peakTravel > engageRows) {
      state.engaged = true;
      state.engagedAt = now;
      state.phase = 'tracking';
      hideHint();
    }

    // The travel maps onto the angle the lid is at, and the fold stops at
    // `foldAngle`: past that the lid keeps going but the picture does not,
    // because a deeper fold only buries it under black. `neutralBand` leaves a
    // dead zone either side of the rest angle so the lid can sit at a working
    // angle with no blur at all.
    const restAngle = Number(settings.restAngle);
    const foldAngle = Number(settings.foldAngle) || 50;
    const span = Math.max(1, restAngle - foldAngle);
    const neutralBand = Math.max(0, Number(settings.neutralBand) || 0);
    const degreesClosed = (state.peakTravel / full) * restAngle * settings.trackerGain;
    const pastNeutral = Math.max(0, degreesClosed - neutralBand);

    let target = NS.gradient.clamp01(pastNeutral / span);
    if (state.releasing) target = 0;
    // A run that is waiting for the monitor's camera to open has no spring yet;
    // give it one so the frame loop is safe while it waits.
    if (!trackerSpring) trackerSpring = new NS.Spring(0, settings.trackerSpringFrequency);
    // The ease back to flat runs at its own, faster frequency: at the tracking
    // frequency it alone takes about half a second, which is what made clicking
    // to exit feel unresponsive.
    trackerSpring.advance(
      target,
      dt,
      state.releasing
        ? (Number(settings.releaseSpringFrequency) || 45)
        : settings.trackerSpringFrequency,
    );
    const progress = NS.gradient.clamp01(trackerSpring.value);

    state.progress = progress;
    state.angle = restAngle - progress * span;
    pushTrace(now);

    if (state.releasing) {
      if (progress <= 0.004) {
        // Flat again, so the picture matches the screen behind it and the fade
        // has nothing to give away.
        state.fadingOut = true;
        state.phase = 'fadeout';
      }
      return;
    }

    // 'auto' is the only mode that ends itself. Anything else - 'key', or the
    // 'click' an older settings file may still hold - means the run stays up,
    // with the camera on, until the exit key is pressed.
    if (settings.releaseOn !== 'auto') return;

    // Release only after a real close, and only once the lid is back at rest.
    const closedProperly = state.maxPeak > full * 0.25;
    const releaseAt = full * settings.releaseFraction;
    // Kept for the debug readout: the whole decision in one object, because a
    // run that will not end is otherwise invisible.
    state.gate = {
      on: settings.releaseOn,
      closedProperly,
      maxPeak: Number(state.maxPeak.toFixed(1)),
      peakTravel: Number(state.peakTravel.toFixed(1)),
      releaseAt: Number.isFinite(releaseAt) ? Number(releaseAt.toFixed(1)) : String(releaseAt),
    };

    if (closedProperly && state.peakTravel < releaseAt) {
      beginRelease('back at rest');
    } else if (!closedProperly && now - state.lastMoveAt > settings.idleReleaseMs) {
      beginRelease('no lid movement');
    } else if (now - state.armedAt > settings.maxArmedMs) {
      beginRelease('armed for too long');
    }
  }


  /**
   * A sample every 100 ms, kept for the run report. When tracking misbehaves on
   * someone else's machine this is the only way to see what it actually did:
   * the numbers behind a wrong-looking fold are invisible in a photograph.
   */
  function pushTrace(now) {
    if (!state.trace || state.trace.length > 700) return;
    const at = now - state.armedAt;
    const last = state.trace[state.trace.length - 1];
    if (last && at - last.t < 100) return;
    state.trace.push({
      t: Math.round(at),
      travel: Number(state.travel.toFixed(1)),
      peak: Number(state.peakTravel.toFixed(1)),
      dir: state.direction,
      progress: Number(state.progress.toFixed(3)),
      angle: Number(state.angle.toFixed(1)),
      quality: Number(state.quality.toFixed(2)),
      strips: state.usedStrips,
      fps: Math.round(state.rate || 0),
    });
  }

  /** Starts the ease back to flat, and turns the camera off straight away. */
  function beginRelease(reason) {
    state.releasing = true;
    state.releaseReason = reason;
    // A monitor-owned stream must survive the release so the next close can be
    // seen; only a run that owns its own camera closes it here.
    if (tracker && !state.reuseMonitor) tracker.close();
    if (window.winDuoBridge && window.winDuoBridge.mark) {
      window.winDuoBridge.mark(`release:${reason}`);
    }
  }

  function frame(now) {
    rafId = 0;
    if (!state) return;
    if (timings && timings.firstFrameMs === null) {
      timings.firstFrameMs = Math.round(now - state.t0);
      if (window.winDuoBridge.mark) window.winDuoBridge.mark('first-frame');
    }

    // Semi-implicit Euler is only stable while frequency * dt stays small.
    const dt = Math.min(Math.max((now - state.lastTime) / 1000, 1 / 240), 1 / 20);
    state.lastTime = now;

    // In camera mode the picture stays completely invisible until the lid
    // actually moves, so that arming does not freeze the desktop on screen. The
    // fade-in then lands on an untouched desktop and has nothing to give away.
    const waiting = state.mode === 'camera' && !state.engaged && !state.releasing;
    const targetOpacity = state.fadingOut || waiting ? 0 : 1;
    // A click is the case where waiting is least welcome, so it gets the short
    // fade.
    const fadeOut = state.releaseReason === 'escape'
      ? (Number(state.settings.clickFadeOut) || 0.12)
      : state.settings.fadeOut;
    const duration = state.fadingOut ? fadeOut : state.settings.fadeIn;
    const step = duration > 0 ? dt / duration : 1;
    state.opacity = targetOpacity > state.opacity
      ? Math.min(targetOpacity, state.opacity + step)
      : Math.max(targetOpacity, state.opacity - step);

    if (state.mode === 'camera') updateFromCamera(dt, now);
    else updateFromSweep(dt, now);

    render(state.angle, state.opacity);
    framesDrawn += 1;
    updateReadout();

    if (state.fadingOut && state.opacity <= 0.0005) {
      const report = {
        mode: state.mode,
        runId: state.runId,
        synthetic: Boolean(state.syntheticCamera),
        engaged: state.engaged,
        peakTravel: state.peakTravel,
        maxPeak: state.maxPeak,
        direction: state.direction,
        quality: state.quality,
        strips: state.usedStrips,
        fps: Math.round(state.rate || 0),
        armedMs: Math.round(performance.now() - state.armedAt),
        reason: state.releaseReason,
        trace: state.trace,
      };
      const closing = tracker;
      const reused = state.reuseMonitor;
      state = null;
      tracker = null;
      trackerSpring = null;
      if (reused) {
        // Hand the same stream straight back to the monitor. It is not closed
        // here; only stopping monitoring closes it.
        releaseMonitorTracker();
      } else {
        if (closing) closing.close();
        // A run that did not reuse the monitor stream still suppressed it;
        // let it re-arm now that the run is over.
        if (monitor.active && monitor.state && monitor.state.state === 'running') {
          monitor.pending = false;
          monitor.state.noteRunFinished();
          scheduleMonitorSample();
        }
      }
      hideHint();
      if (readoutElement) readoutElement.style.opacity = '0';
      if (window.winDuoBridge) window.winDuoBridge.finished(report);
      return;
    }

    rafId = window.requestAnimationFrame(frame);
  }

  // --- Entry points -------------------------------------------------------

  function prepare(payload) {
    const settings = payload.settings;

    // The window is the screen here, so its own size is the authority. The
    // display size the main process computes can differ by a fraction of a point
    // once Windows rounds the window out to whole device pixels, and a mismatch
    // shows up as a transparent hairline down one edge.
    const screenWidth = payload.fixedCanvas ? payload.screenWidth : window.innerWidth;
    const screenHeight = payload.fixedCanvas ? payload.screenHeight : window.innerHeight;
    const pixelScale = payload.fixedCanvas ? payload.pixelScale : window.devicePixelRatio;

    canvas.style.width = `${screenWidth}px`;
    canvas.style.height = `${screenHeight}px`;
    canvas.width = Math.max(1, Math.round(screenWidth * pixelScale));
    canvas.height = Math.max(1, Math.round(screenHeight * pixelScale));

    let sourceCanvas = null;
    let width = canvas.width;
    let height = canvas.height;
    if (payload.synthetic) {
      sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      drawTestPattern(sourceCanvas.getContext('2d'), width, height);
    } else {
      width = payload.width;
      height = payload.height;
    }

    const built = buildPicture({
      width,
      height,
      bgra: payload.bgra,
      sourceCanvas,
      paddingPoints: settings.paddingPoints,
      pixelScale,
    });

    // Camera mode follows the real lid. The picture is flat at `restAngle`,
    // which is the angle the lid stands at when the effect arms, so the fold
    // begins the moment the lid moves.
    const mode = settings.angleSource === 'camera' ? 'camera' : 'sweep';
    const startAngle = mode === 'camera' ? Number(settings.restAngle) : settings.thresholdAngle;

    state = {
      settings,
      mode,
      pixelScale,
      screenWidth,
      screenHeight,
      paddingPoints: settings.paddingPoints,
      maxLevel: built.maxLevel,
      startAngle,
      openAngle: payload.openAngle,
      shutAngle: payload.shutAngle,
      t0: performance.now(),
      lastTime: performance.now(),
      angle: startAngle,
      progress: 0,
      opacity: 0,
      fadingOut: false,
      phase: mode === 'camera' ? 'armed' : 'sweep',
      spring: new NS.Spring(payload.openAngle, settings.springFrequency),
      // Live tracking state.
      travel: 0,
      lastInverse: null,
      // True when the tracker is running against a generated scene rather than
      // the camera. Reported back so the main process can leave the calibration
      // alone: a synthetic run would otherwise teach the user's settings a
      // travel distance that came out of a test pattern.
      syntheticCamera: Boolean(payload.syntheticCamera),
      // True when this run should adopt the monitor's already-open tracker
      // instead of opening its own stream.
      reuseMonitor: Boolean(payload.reuseMonitor),
      // Echoed back in the completion report, so a late report from an older
      // run cannot end a newer one in the main process.
      runId: payload.runId,
      // +1 or -1: which sign of tracked travel means the lid is closing. Latched
      // from the first real movement, because it depends on the hardware.
      direction: 1,
      peakMagnitude: 0,
      // The furthest the lid has been closed this run, which is what the picture
      // follows. Never wound back by noise, and followed down only through a lag.
      peakTravel: 0,
      maxPeak: 0,
      lastIdleTravel: 0,
      lastMoveAt: performance.now(),
      rate: 0,
      trace: [],
      quality: 0,
      usedStrips: 0,
      engaged: false,
      engagedAt: 0,
      releasing: false,
      releaseReason: '',
      armedAt: performance.now(),
    };
  }

  /** Falls back to the scripted sweep when the camera cannot be used. */
  function fallbackToSweep(note) {
    state.mode = 'sweep';
    state.phase = 'sweep';
    state.startAngle = state.settings.thresholdAngle;
    state.spring = new NS.Spring(state.openAngle, state.settings.springFrequency);
    state.t0 = performance.now();
    tracker = null;
    trackerSpring = null;
    showHint(note ? `摄像头打不开，改用脚本动画：${note}` : '脚本动画', note ? 6000 : 1500);
  }

  /**
   * Opens the camera and starts tracking. Runs after the picture is up, so the
   * cost of the camera is not added to the cost of the screen grab.
   */
  async function startCamera(payload) {
    const local = new NS.LidTracker({
      synthetic: Boolean(payload.syntheticCamera),
      deviceId: payload.settings.cameraDeviceId,
    });
    // The run this camera belongs to. `state` is replaced when a new run starts
    // and cleared when one ends, so comparing against it after the await below
    // tells us whether this camera is still wanted.
    const run = state;
    tracker = local;
    trackerSpring = new NS.Spring(0, run.settings.trackerSpringFrequency);

    let opened = false;
    try {
      opened = await local.open();
    } catch (error) {
      // open() reports failure by returning false; an unexpected throw must not
      // escape as an unhandled rejection. Release anything it acquired.
      local.note = `摄像头打不开: ${error ? error.message : '未知错误'}`;
      local.close();
      opened = false;
    }

    // The run ended, or a later run replaced this one, while the camera was
    // still opening. Drop the late result instead of touching the new state.
    if (run.releasing || state !== run || tracker !== local) {
      local.close();
      return;
    }

    if (!opened) {
      // A dead overlay would be worse than the wrong animation, so fall back to
      // the scripted sweep and say so.
      fallbackToSweep(local.note);
      return;
    }

    if (local.synthetic) {
      // Only present when the tracker is running against a generated scene. It
      // lets a harness close the lid with no camera and no hand, which is the
      // only way to test the live path automatically.
      window.__winDuoTrack = {
        get offset() { return local.offset; },
        step(pixels) { local.offset += pixels; return local.offset; },
        reset() { local.reset(); },
      };
    }

    showHint('已待命 · 慢慢合盖', 8000);
    if (window.winDuoBridge && window.winDuoBridge.mark) window.winDuoBridge.mark('camera-ready');
  }

  // --- Persistent monitor -------------------------------------------------

  /** A finite number, or the fallback. Keeps a legitimate 0 from being lost. */
  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function newMonitorState(config) {
    return new NS.MonitorState({
      triggerAngle: config.triggerAngle,
      rearmAngle: config.rearmAngle,
      restAngle: config.restAngle,
      fullTravel: config.fullTravel,
      gain: config.trackerGain,
    });
  }

  function applyMonitorConfig(config) {
    const source = config || {};
    monitor.config = {
      deviceId: typeof source.deviceId === 'string' ? source.deviceId : '',
      synthetic: Boolean(source.syntheticCamera),
      restAngle: numberOr(source.restAngle, 105),
      fullTravel: Math.max(1, numberOr(source.fullTravel, 170)),
      trackerGain: numberOr(source.trackerGain, 1),
      triggerAngle: numberOr(source.triggerAngle, 12),
      // Zero is a legitimate re-arm angle: `|| 5` would silently swallow it.
      rearmAngle: Math.max(0, numberOr(source.rearmAngle, 5)),
    };
    if (monitor.state) {
      monitor.state.configure({
        triggerAngle: monitor.config.triggerAngle,
        rearmAngle: monitor.config.rearmAngle,
        restAngle: monitor.config.restAngle,
        fullTravel: monitor.config.fullTravel,
        gain: monitor.config.trackerGain,
      });
    }
  }

  function monitorWantsSameDevice() {
    return Boolean(monitor.tracker)
      && monitor.tracker.deviceId === monitor.config.deviceId
      && Boolean(monitor.tracker.synthetic) === monitor.config.synthetic;
  }

  function scheduleMonitorSample() {
    if (monitor.timer) return;
    if (!monitor.active || monitor.paused || !monitor.ready || !monitor.tracker) return;
    monitor.timer = window.setTimeout(sampleMonitor, MONITOR_INTERVAL_MS);
  }

  function reportMonitorStatus(active, error) {
    if (window.winDuoBridge && window.winDuoBridge.monitorStatus) {
      window.winDuoBridge.monitorStatus({
        active: Boolean(active),
        error: error || '',
        generation: monitor.generation,
      });
    }
  }

  /**
   * One monitor sample. A crossing is reported to the main process exactly
   * once, then suppressed until the main process either starts a run or tells
   * this page to resume.
   */
  function sampleMonitor() {
    monitor.timer = 0;
    if (!monitor.active || monitor.paused || !monitor.ready || !monitor.tracker) return;
    const travel = monitor.tracker.sample();
    if (travel !== null && monitor.state) {
      const event = monitor.state.update(travel);
      monitor.lastTravel = travel;
      if (event.direction) monitor.direction = event.direction;
      if (event.crossed && !monitor.pending) {
        monitor.pending = true;
        monitor.crossings += 1;
        if (window.winDuoBridge && window.winDuoBridge.monitorCrossed) {
          window.winDuoBridge.monitorCrossed({
            // The generation this crossing was seen under. The main process
            // rejects a crossing whose generation is no longer current, so one
            // that was in flight when the monitor was stopped or reconfigured
            // cannot start an automatic run.
            generation: monitor.generation,
            travel,
            direction: monitor.direction,
            angle: event.angle,
            synthetic: Boolean(monitor.config && monitor.config.synthetic),
          });
        }
      }
    }
    scheduleMonitorSample();
  }

  /**
   * Opens the one stream the monitor keeps. Called again with new settings
   * while monitoring is on: the same camera is left open and only the config
   * changes, while a different camera replaces the stream.
   *
   * A start carries a generation from the main process. An older generation
   * than the last one applied is ignored, so a start that arrives after a stop
   * cannot resurrect the monitor.
   */
  async function startMonitor(config) {
    const generation = numberOr(config && config.generation, NaN);
    if (Number.isFinite(generation) && generation < monitor.generation) return;
    if (Number.isFinite(generation)) monitor.generation = generation;

    applyMonitorConfig(config);
    monitor.active = true;
    monitor.closeAfterRun = false;

    // A run currently owns the stream. If a different camera is now wanted,
    // remember to reopen it when the run hands the tracker back; the stream is
    // never swapped out from under a live run.
    if (monitor.runOwnsTracker) {
      if (!monitorWantsSameDevice()) monitor.reopenAfterRun = true;
      return;
    }

    if (monitorWantsSameDevice() && (monitor.ready || monitor.opening)) {
      // Same camera, already open or still opening. Only the config changes;
      // opening again here would be a second getUserMedia on the same device.
      monitor.paused = false;
      // A reconfigure that lands while a crossing is still pending must clear
      // the latch as well as re-arm. Every start carries a newer generation, and
      // the main process revalidates the in-flight automatic run against it and
      // aborts it, so that crossing can never become a run. Leaving `pending`
      // set would make sampleMonitor refuse to report the next close and wedge
      // the monitor. The guard is the state itself: a no-op start leaves the
      // state as 'watching' or 'running' and never reaches here, so a crossing
      // that is still legitimately waiting for its run is not erased.
      if (monitor.ready && !monitor.runOwnsTracker
        && monitor.state && monitor.state.state === 'triggered') {
        monitor.pending = false;
        monitor.state.noteRunFinished();
      }
      if (monitor.ready) scheduleMonitorSample();
      return;
    }

    enqueueMonitorOpen();
  }

  /**
   * Queues an open. Opens are serialized, so a camera change that arrives while
   * an earlier getUserMedia is still in flight waits for it to settle (and be
   * closed) before starting the next one. Only one physical stream is ever
   * opening at a time.
   */
  function enqueueMonitorOpen() {
    const token = (monitor.token += 1);
    monitor.openChain = monitor.openChain
      .then(() => openMonitorDevice(token))
      .catch((error) => {
        console.error('[win-duo] monitor open failed:', error && error.message);
      });
  }

  async function openMonitorDevice(token) {
    // Superseded while queued behind an earlier open.
    if (!monitor.active || monitor.token !== token) return;

    if (monitor.timer) {
      window.clearTimeout(monitor.timer);
      monitor.timer = 0;
    }
    if (monitor.tracker) {
      monitor.tracker.close();
      monitor.tracker = null;
    }
    monitor.ready = false;
    monitor.crossings = 0;
    monitor.reusedLastRun = false;
    window.__winDuoMonitorTrack = null;

    const local = new NS.LidTracker({
      synthetic: monitor.config.synthetic,
      deviceId: monitor.config.deviceId,
    });
    monitor.tracker = local;
    monitor.state = newMonitorState(monitor.config);
    monitor.direction = 1;
    monitor.lastTravel = 0;
    monitor.opening = true;

    let opened = false;
    try {
      opened = await local.open();
    } catch (error) {
      local.note = `摄像头打不开: ${error ? error.message : '未知错误'}`;
      local.close();
      opened = false;
    } finally {
      monitor.opening = false;
    }

    // Stopped, replaced, or superseded while opening: close the late stream
    // rather than leaving the camera light on with nothing watching it.
    if (!monitor.active || monitor.token !== token || monitor.tracker !== local) {
      local.close();
      return;
    }

    if (!opened) {
      monitor.active = false;
      monitor.ready = false;
      monitor.tracker = null;
      monitor.state = null;
      reportMonitorStatus(false, local.note);
      showHint(`摄像头打不开，自动监测已关闭：${local.note}`, 6000);
      return;
    }

    monitor.ready = true;
    monitor.paused = false;
    monitor.reopenAfterRun = false;
    monitor.state.start(local.sample());
    monitor.direction = monitor.state.direction || 1;
    monitor.lastTravel = 0;

    if (local.synthetic) {
      window.__winDuoMonitorTrack = {
        get offset() { return local.offset; },
        step(pixels) { local.offset += pixels; return local.offset; },
        reset() { local.reset(); },
      };
    }

    reportMonitorStatus(true, '');
    showHint('自动监测中 · 合盖自动折叠', 4000);
    scheduleMonitorSample();
  }

  /** Stops monitoring and closes the stream, unless a run still owns it. */
  function stopMonitor(payload) {
    const generation = numberOr(payload && payload.generation, NaN);
    if (Number.isFinite(generation) && generation < monitor.generation) return;
    if (Number.isFinite(generation)) monitor.generation = generation;

    monitor.active = false;
    monitor.paused = true;
    monitor.pending = false;
    monitor.reopenAfterRun = false;
    if (monitor.state) monitor.state.stop();
    if (monitor.timer) {
      window.clearTimeout(monitor.timer);
      monitor.timer = 0;
    }
    window.__winDuoMonitorTrack = null;
    // Bump the token so a queued or in-flight open is cancelled when it
    // resolves, even if a run currently owns the previous stream.
    monitor.token += 1;
    if (monitor.runOwnsTracker) {
      // A run still holds the stream; close it when that run finishes.
      monitor.closeAfterRun = true;
      return;
    }
    if (monitor.tracker) {
      monitor.tracker.close();
      monitor.tracker = null;
    }
    monitor.ready = false;
  }

  /** The main process could not start a run; keep watching safely. */
  function resumeMonitor(payload) {
    const generation = numberOr(payload && payload.generation, NaN);
    if (Number.isFinite(generation) && generation !== monitor.generation) return;
    if (!monitor.active || !monitor.ready) return;
    monitor.pending = false;
    monitor.paused = false;
    // Suppress the crossing that was just reported until the lid re-arms.
    if (monitor.state) monitor.state.noteRunFinished();
    scheduleMonitorSample();
  }

  /**
   * Hands the monitor's stream to a visual run. Returns false when there is no
   * usable monitor tracker, in which case the caller must not open a second
   * camera for an automatic run.
   */
  function adoptMonitorTracker() {
    const run = state;
    if (!monitor.tracker || !monitor.tracker.available) return false;

    monitor.paused = true;
    monitor.pending = false;
    monitor.runOwnsTracker = true;
    monitor.reusedLastRun = true;
    if (monitor.state) monitor.state.noteRunStarted();

    tracker = monitor.tracker;
    const full = Math.max(1, Number(run.settings.fullTravel) || 170);
    const engageRows = full * run.settings.engageFraction;
    run.travel = monitor.lastTravel;
    run.direction = monitor.direction || 1;
    run.peakMagnitude = Math.abs(monitor.lastTravel);
    const seeded = Math.max(0, monitor.lastTravel * run.direction);
    run.peakTravel = seeded;
    run.maxPeak = seeded;

    // Seed the spring at the current lid position, so the fold picks up where
    // the lid already is instead of snapping up from flat.
    const restAngle = Number(run.settings.restAngle);
    const foldAngle = Number(run.settings.foldAngle) || 50;
    const span = Math.max(1, restAngle - foldAngle);
    const neutralBand = Math.max(0, Number(run.settings.neutralBand) || 0);
    const degrees = (seeded / full) * restAngle * (Number(run.settings.trackerGain) || 1);
    const progress = NS.gradient.clamp01(Math.max(0, degrees - neutralBand) / span);
    trackerSpring = new NS.Spring(progress, run.settings.trackerSpringFrequency);
    run.progress = progress;
    run.angle = restAngle - progress * span;

    if (seeded > engageRows) {
      run.engaged = true;
      run.engagedAt = performance.now();
      run.phase = 'tracking';
      hideHint();
    }
    return true;
  }

  /**
   * Called when a run that reused the monitor tracker finishes: the stream is
   * handed straight back to the monitor, never closed, unless monitoring was
   * switched off while the run was up.
   */
  function releaseMonitorTracker() {
    if (!monitor.runOwnsTracker) return;
    monitor.runOwnsTracker = false;
    if (monitor.closeAfterRun || !monitor.active) {
      monitor.closeAfterRun = false;
      monitor.reopenAfterRun = false;
      if (monitor.tracker) {
        monitor.tracker.close();
        monitor.tracker = null;
      }
      monitor.ready = false;
      return;
    }
    // A camera change that arrived while the run owned the stream is applied
    // now, so the requested device is actually opened instead of the old one
    // being reused forever.
    if (monitor.reopenAfterRun || !monitorWantsSameDevice()) {
      monitor.reopenAfterRun = false;
      if (monitor.tracker) {
        monitor.tracker.close();
        monitor.tracker = null;
      }
      monitor.ready = false;
      enqueueMonitorOpen();
      return;
    }
    monitor.paused = false;
    monitor.pending = false;
    if (monitor.state) monitor.state.noteRunFinished();
    scheduleMonitorSample();
  }

  /**
   * Uses the monitor's stream for this run. If the monitor is still opening its
   * camera, this waits a bounded time for it rather than opening a second
   * stream. If no stream can be had it falls back to the scripted sweep: an
   * automatic run must never open its own camera, and a manual run keeps the
   * single-stream promise while monitoring is active.
   */
  async function adoptOrWaitForMonitor() {
    const run = state;
    if (!run) return;
    const deadline = performance.now() + MONITOR_ADOPT_WAIT_MS;
    while (state === run && !run.releasing && !run.fadingOut) {
      if (adoptMonitorTracker()) return;
      if (!monitor.active) break;
      if (performance.now() >= deadline) break;
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    }
    if (state !== run || run.releasing) return;
    // No monitor stream to reuse. Fall back to the scripted sweep and let the
    // monitor re-arm once this run is over.
    run.reuseMonitor = false;
    if (monitor.active && monitor.state) {
      monitor.pending = false;
      monitor.state.noteRunStarted();
    }
    fallbackToSweep('');
  }

  // The main process can ask what the monitor is doing, and the verification
  // harness drives the synthetic scene through __winDuoMonitorTrack.
  window.__winDuoMonitorDebug = () => ({
    active: monitor.active,
    ready: monitor.ready,
    paused: monitor.paused,
    pending: monitor.pending,
    opening: monitor.opening,
    runOwnsTracker: monitor.runOwnsTracker,
    reopenAfterRun: monitor.reopenAfterRun,
    hasTracker: Boolean(monitor.tracker),
    deviceId: monitor.tracker ? monitor.tracker.deviceId : (monitor.config ? monitor.config.deviceId : ''),
    synthetic: monitor.tracker ? Boolean(monitor.tracker.synthetic) : Boolean(monitor.config && monitor.config.synthetic),
    generation: monitor.generation,
    travel: Number(monitor.lastTravel.toFixed(2)),
    direction: monitor.direction,
    state: monitor.state ? monitor.state.state : 'off',
    angle: monitor.state ? Number(monitor.state.lastAngle.toFixed(2)) : 0,
    crossings: monitor.crossings,
    reused: monitor.reusedLastRun,
  });

  function play(payload) {
    try {
      const received = performance.now();
      prepare(payload);
      const built = performance.now();
      state.opacity = 0;
      state.lastTime = built;
      timings = {
        buildMs: Math.round(built - received),
        // Filled in by the first drawn frame.
        firstFrameMs: null,
        bytes: payload.bgra ? payload.bgra.length : 0,
      };
      if (state.mode === 'camera') {
        if (state.reuseMonitor) {
          // The monitor owns the camera. Adopt its stream, waiting briefly for
          // it to finish opening rather than opening a second physical stream.
          adoptOrWaitForMonitor();
        } else {
          // The monitor is not active: a manual run may open its own camera.
          startCamera(payload);
        }
      } else {
        showHint('脚本动画', 1500);
      }
      // A run is now up. If it is not reusing the monitor stream (a scripted
      // run, say), the monitor must still stop firing until the run is over;
      // it is re-armed in the run's fade-out below.
      if (monitor.active && !state.reuseMonitor && monitor.state) {
        monitor.pending = false;
        monitor.state.noteRunStarted();
      }
      if (!rafId) rafId = window.requestAnimationFrame(frame);
      if (window.winDuoBridge.mark) window.winDuoBridge.mark('picture-built');
    } catch (error) {
      lastError = String((error && error.stack) || error);
      throw error;
    }
  }

  if (selfTest) {
    let pending = null;
    window.__winDuoSelftest = {
      store(payload) {
        pending = payload;
        return true;
      },
      prepareStored() {
        prepare(pending);
        state.phase = 'static';
        state.opacity = 1;
        return true;
      },
      renderAt(angle) {
        render(angle, 1);
        return canvas.toDataURL('image/png');
      },
    };
  }

  /**
   * Reports what the shader does at a given screen point: whether the picture
   * covers it, and where in the picture it lands. `covered: false` means the
   * shader paints black there - which is correct - but anything that reaches the
   * screen uncovered instead is a leak.
   *
   * `yFromBottom` is in points, measured up from the bottom edge of the screen,
   * and `x` across it, so the numbers line up with the geometry.
   */
  window.__winDuoProbe = (x, yFromBottom) => {
    if (!state || !state.lastInverse) return null;
    const m = state.lastInverse;
    const sx = x;
    const sy = yFromBottom;
    const px = m[0] * sx + m[3] * sy + m[6];
    const py = m[1] * sx + m[4] * sy + m[7];
    const pw = m[2] * sx + m[5] * sy + m[8];
    if (Math.abs(pw) < 1e-9) return { degenerate: true };
    const picturePoint = [px / pw, py / pw];
    const padding = state.paddingPoints;
    const unit = [
      (picturePoint[0] + padding) / (state.screenWidth + 2 * padding),
      (picturePoint[1] + padding) / (state.screenHeight + 2 * padding),
    ];
    return {
      angle: Number(state.angle.toFixed(2)),
      progress: Number(state.progress.toFixed(3)),
      screen: [Math.round(sx), Math.round(sy)],
      screenHeight: state.screenHeight,
      picturePoint: picturePoint.map((v) => Number(v.toFixed(1))),
      unit: unit.map((v) => Number(v.toFixed(4))),
      covered: unit[0] >= 0 && unit[0] <= 1 && unit[1] >= 0 && unit[1] <= 1,
    };
  };

  if (window.winDuoBridge) {
    window.winDuoBridge.onPlay(play);
    window.winDuoBridge.onSettings((settings) => {
      if (state) state.settings = settings;
    });
    // Escape ends the run. It is registered globally by the main process and
    // only while a run is up, so it also cancels a run that was armed by
    // accident before the lid ever moved.
    if (window.winDuoBridge.onExit) {
      window.winDuoBridge.onExit(() => {
        if (!state || state.releasing) return;
        beginRelease('escape');
      });
    }
    // The persistent monitor: one stream kept open between runs. The main
    // process owns the decision to start a run; this page only reports a
    // crossing and hands the tracker over.
    if (window.winDuoBridge.onMonitorStart) {
      window.winDuoBridge.onMonitorStart((config) => { startMonitor(config); });
    }
    if (window.winDuoBridge.onMonitorStop) {
      window.winDuoBridge.onMonitorStop((payload) => { stopMonitor(payload); });
    }
    if (window.winDuoBridge.onMonitorResume) {
      window.winDuoBridge.onMonitorResume((payload) => { resumeMonitor(payload); });
    }
    if (selfTest) window.winDuoBridge.onSelftestPayload((payload) => window.__winDuoSelftest.store(payload));
  }
})();
