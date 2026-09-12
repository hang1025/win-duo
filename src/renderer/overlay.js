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
      readoutElement.textContent = [
        `角度 ${state.angle.toFixed(1)}°`,
        `行程 ${state.peakTravel.toFixed(0)}/${Number(state.settings.fullTravel).toFixed(0)}`,
        `${(state.progress * 100).toFixed(0)}%`,
        `${Math.round(state.rate || 0)}fps`,
        `q${state.quality.toFixed(2)} ${state.usedStrips}/8`,
        state.releasing ? '收尾中' : (state.engaged ? '跟随中' : '待命'),
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
    const retraceDeadband = full * settings.retraceFraction;

    // Which way the scene slides when the lid closes depends on how the camera
    // is mounted and how the user sits, so the sign is latched from the largest
    // excursion rather than assumed.
    const magnitude = Math.abs(state.travel);
    if (magnitude > engageRows && magnitude > state.peakMagnitude) {
      state.peakMagnitude = magnitude;
      state.direction = Math.sign(state.travel) || state.direction;
    }
    const closingTravel = state.travel * state.direction;

    // A ratchet. The picture follows the furthest the lid has been closed and
    // only follows it back down once a reversal has held for a moment. Two
    // things make this necessary: tracker noise wobbling backwards, and the real
    // reversal part way through a close, when the camera stops looking at the
    // room and starts looking at the keyboard. Without it the fold jumps back
    // mid-close, and a hard enough jump used to end the whole run.
    if (closingTravel > state.peakTravel) {
      state.peakTravel = closingTravel;
      state.retraceAt = 0;
    } else if (state.peakTravel - closingTravel > retraceDeadband) {
      if (!state.retraceAt) state.retraceAt = now;
      else if (now - state.retraceAt > settings.retraceHoldMs) state.peakTravel = closingTravel;
    } else {
      state.retraceAt = 0;
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

    let target = NS.gradient.clamp01((state.peakTravel / full) * settings.trackerGain);
    if (state.releasing) target = 0;
    trackerSpring.advance(target, dt, settings.trackerSpringFrequency);
    const progress = NS.gradient.clamp01(trackerSpring.value);

    state.progress = progress;
    state.angle = Number(settings.restAngle) * (1 - progress);
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

    // Release only after a real close, and only once the lid is back at rest.
    // Comparing against the peak rather than against zero is what stops a
    // mid-close reversal from throwing the effect away.
    const closedProperly = state.maxPeak > full * 0.25;
    if (closedProperly && state.peakTravel < full * settings.retraceReleaseFraction) {
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
    if (tracker) tracker.close();
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
    const duration = state.fadingOut ? state.settings.fadeOut : state.settings.fadeIn;
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
      state = null;
      tracker = null;
      trackerSpring = null;
      if (closing) closing.close();
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
      // +1 or -1: which sign of tracked travel means the lid is closing. Latched
      // from the first real movement, because it depends on the hardware.
      direction: 1,
      peakMagnitude: 0,
      // The furthest the lid has been closed this run, which is what the picture
      // follows. Ratcheted so noise and mid-close reversals cannot wind it back.
      peakTravel: 0,
      maxPeak: 0,
      retraceAt: 0,
      lastIdleTravel: 0,
      lastMoveAt: performance.now(),
      rate: 0,
      trace: [],
      quality: 0,
      usedStrips: 0,
      engaged: false,
      engagedAt: 0,
      peakTravel: 0,
      releasing: false,
      releaseReason: '',
      armedAt: performance.now(),
    };
  }

  /**
   * Opens the camera and starts tracking. Runs after the picture is up, so the
   * cost of the camera is not added to the cost of the screen grab.
   */
  async function startCamera(payload) {
    const local = new NS.LidTracker({ synthetic: Boolean(payload.syntheticCamera) });
    tracker = local;
    trackerSpring = new NS.Spring(0, state.settings.trackerSpringFrequency);

    const opened = await local.open();
    if (!state) return;

    if (!opened) {
      // A dead overlay would be worse than the wrong animation, so fall back to
      // the scripted sweep and say so.
      state.mode = 'sweep';
      state.phase = 'sweep';
      state.startAngle = state.settings.thresholdAngle;
      state.spring = new NS.Spring(state.openAngle, state.settings.springFrequency);
      state.t0 = performance.now();
      tracker = null;
      trackerSpring = null;
      showHint(`摄像头打不开，改用脚本动画：${local.note}`, 6000);
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
      if (state.mode === 'camera') startCamera(payload);
      else showHint('脚本动画', 1500);
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
    if (selfTest) window.winDuoBridge.onSelftestPayload((payload) => window.__winDuoSelftest.store(payload));
  }
})();
