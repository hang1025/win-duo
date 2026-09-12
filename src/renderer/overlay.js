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
        phase: state.phase,
        opacity: Number(state.opacity.toFixed(3)),
        angle: Number(state.spring.value.toFixed(2)),
        openAngle: state.openAngle,
        shutAngle: state.shutAngle,
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

    const targetOpacity = state.fadingOut ? 0 : 1;
    const duration = state.fadingOut ? state.settings.fadeOut : state.settings.fadeIn;
    const step = duration > 0 ? dt / duration : 1;
    state.opacity = targetOpacity > state.opacity
      ? Math.min(targetOpacity, state.opacity + step)
      : Math.max(targetOpacity, state.opacity - step);

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

    render(state.spring.value, state.opacity);
    framesDrawn += 1;

    if (state.phase === 'fadeout' && state.opacity <= 0.0005) {
      state = null;
      if (window.winDuoBridge) window.winDuoBridge.finished();
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

    state = {
      settings,
      pixelScale,
      screenWidth,
      screenHeight,
      paddingPoints: settings.paddingPoints,
      maxLevel: built.maxLevel,
      // The effect arms at the threshold, so that is the angle the picture is
      // flat at.
      startAngle: settings.thresholdAngle,
      openAngle: payload.openAngle,
      shutAngle: payload.shutAngle,
      t0: performance.now(),
      lastTime: performance.now(),
      opacity: 0,
      fadingOut: false,
      phase: 'sweep',
      spring: new NS.Spring(payload.openAngle, settings.springFrequency),
    };
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

  if (window.winDuoBridge) {
    window.winDuoBridge.onPlay(play);
    window.winDuoBridge.onSettings((settings) => {
      if (state) state.settings = settings;
    });
    if (selfTest) window.winDuoBridge.onSelftestPayload((payload) => window.__winDuoSelftest.store(payload));
  }
})();
