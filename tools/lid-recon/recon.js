/*
 * Lid signal recon - the renderer.
 *
 * Runs the collectors that need a browser context (camera, audio), drives the
 * guided protocol, and draws it all live so the answer can also just be looked
 * at rather than only computed.
 */
(function () {
  'use strict';

  const bridge = window.recon;
  const NS = window.WinDuo;
  const $ = (id) => document.getElementById(id);
  /**
   * Synthetic mode feeds the tracker a generated scene moved by a known number
   * of pixels instead of a camera. It is how the maths gets checked without
   * opening anyone's webcam.
   */
  const SYNTHETIC = new URLSearchParams(window.location.search).get('synthetic') === '1';

  // --- protocol ------------------------------------------------------------

  const CYCLES = 5;
  const PHASES = [
    { key: 'open', label: '全开保持', hint: '把盖子完全打开，停住，别碰它', ms: 2000, cue: [700] },
    { key: 'close', label: '慢慢合上', hint: '用 4 秒匀速合到完全关上', ms: 4000, cue: [700, 900] },
    { key: 'shut', label: '全合保持', hint: '完全合上，停住', ms: 2000, cue: [500] },
    { key: 'reopen', label: '慢慢打开', hint: '用 4 秒匀速开回全开', ms: 4000, cue: [700, 900] },
    { key: 'rest', label: '休息一下', hint: '手离开盖子', ms: 1500, cue: [] },
  ];

  // --- audio cues ----------------------------------------------------------

  const cues = {
    ctx: null,
    ensure() {
      if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 48000 });
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    play(frequencies) {
      if (!frequencies.length) return;
      const ctx = this.ensure();
      const at = ctx.currentTime;
      frequencies.forEach((frequency, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        const start = at + index * 0.16;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.012);
        gain.gain.linearRampToValueAtTime(0, start + 0.13);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.15);
      });
    },
  };

  // --- collectors ----------------------------------------------------------

  /**
   * The camera signal, wrapped for the collector loop.
   *
   * The tracking itself lives in src/renderer/lib/lid-tracker.js, because the
   * overlay uses the same code. Two copies of a tracker would be two places for
   * a drift bug to hide.
   */
  class CameraCollector {
    constructor() {
      this.name = 'camera';
      this.intervalMs = 33;
      this.unit = 'px';
      this.digits = 1;
      // null means "not tried yet": the camera only opens when a run starts.
      this.available = null;
      this.note = '按下“开始记录”后启动';
      this.tracker = new NS.LidTracker({ synthetic: SYNTHETIC });
    }

    async start() {
      const opened = await this.tracker.open();
      this.available = opened;
      this.note = opened ? '' : (this.tracker.note || '摄像头打不开');
      return opened;
    }

    /** Called when a cycle starts: the shift is measured from here. */
    reset() {
      this.tracker.reset();
    }

    sample() {
      return this.tracker.sample();
    }

    /** Short status for the badge. */
    describe() {
      return this.available ? `on ${this.tracker.describe()}` : '';
    }

    stop() {
      this.tracker.close();
      this.available = null;
    }
  }

  /** Level of a probe tone at the microphone, in dB. */
  class AudioCollector {
    constructor() {
      this.name = 'audio';
      this.intervalMs = 50;
      this.unit = 'dB';
      this.digits = 1;
      this.available = null;
      this.note = '按下“开始记录”后启动';
      this.probeHz = 18000;
      this.probeLevel = 0;
      this.baseline = null;
    }

    /** Plays a tone at each frequency and reports what the microphone hears. */
    static async scan(frequencies) {
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const results = [];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      gain.gain.value = 0.25;
      osc.connect(gain).connect(ctx.destination);
      osc.start();

      let stream = null;
      let analyser = null;
      let bins = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        bins = new Float32Array(analyser.frequencyBinCount);
      } catch (error) {
        osc.stop();
        ctx.close();
        return { error: error.message, results: [] };
      }

      for (const frequency of frequencies) {
        osc.frequency.value = frequency;
        await new Promise((r) => setTimeout(r, 320));
        let peak = -Infinity;
        for (let i = 0; i < 12; i += 1) {
          analyser.getFloatFrequencyData(bins);
          const bin = Math.round(frequency / (ctx.sampleRate / analyser.fftSize));
          for (let k = Math.max(0, bin - 2); k <= Math.min(bins.length - 1, bin + 2); k += 1) {
            peak = Math.max(peak, bins[k]);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        results.push({ frequency, level: peak });
      }

      osc.stop();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      return { results };
    }

    async start(probeHz) {
      if (!probeHz) {
        this.note = 'no probe frequency';
        return false;
      }
      this.probeHz = probeHz;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (error) {
        this.note = `麦克风不可用: ${error.message}`;
        return false;
      }
      this.ctx = new AudioContext({ sampleRate: 48000 });
      await this.ctx.resume();
      this.osc = this.ctx.createOscillator();
      this.gain = this.ctx.createGain();
      this.osc.type = 'sine';
      this.osc.frequency.value = probeHz;
      this.gain.gain.value = 0.25;
      this.osc.connect(this.gain).connect(this.ctx.destination);
      this.osc.start();

      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.smoothingTimeConstant = 0;
      this.source.connect(this.analyser);
      this.bins = new Float32Array(this.analyser.frequencyBinCount);
      this.bin = Math.round(probeHz / (this.ctx.sampleRate / this.analyser.fftSize));
      this.available = true;
      return true;
    }

    sample() {
      if (!this.available) return null;
      this.analyser.getFloatFrequencyData(this.bins);
      let peak = -Infinity;
      for (let k = Math.max(0, this.bin - 2); k <= Math.min(this.bins.length - 1, this.bin + 2); k += 1) {
        peak = Math.max(peak, this.bins[k]);
      }
      return peak;
    }

    stop() {
      if (this.osc) { try { this.osc.stop(); } catch (e) { /* already stopped */ } }
      if (this.ctx) this.ctx.close();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.available = null;
    }
  }

  /** Wi-Fi signal percentage, polled in the main process. */
  class WifiCollector {
    constructor() {
      this.name = 'wifi';
      this.intervalMs = 250;
      this.unit = '%';
      this.digits = 0;
      this.available = false;
      this.note = '';
      this.pending = false;
    }

    async start() {
      const probe = await bridge.wifi();
      if (probe && typeof probe.value === 'number') {
        this.available = true;
        return true;
      }
      this.note = (probe && probe.note) || '没有可用的无线连接';
      return false;
    }

    sample() {
      if (!this.available) return null;
      if (!this.pending) {
        this.pending = true;
        bridge.wifi().then((result) => {
          this.pending = false;
          if (result && typeof result.value === 'number') {
            this.latest = result.value;
            this.latestAt = Date.now();
          }
        });
      }
      // Only report a value that is recent enough to belong to this moment.
      if (this.latest !== undefined && Date.now() - this.latestAt < 1200) return this.latest;
      return null;
    }
  }

  /** Ambient light, polled in the main process. Absent on most laptops. */
  class LightCollector {
    constructor() {
      this.name = 'light';
      this.intervalMs = 100;
      this.unit = 'lux';
      this.digits = 2;
      this.available = false;
      this.note = '';
      this.pending = false;
    }

    start() {
      return bridge.light().then((probe) => {
        this.available = Boolean(probe && probe.available);
        this.note = (probe && probe.note) || '';
        return this.available;
      });
    }

    sample() {
      if (!this.available) return null;
      if (!this.pending) {
        this.pending = true;
        bridge.light().then((result) => {
          this.pending = false;
          if (result && typeof result.value === 'number') {
            this.latest = result.value;
            this.latestAt = Date.now();
          }
        });
      }
      if (this.latest !== undefined && Date.now() - this.latestAt < 600) return this.latest;
      return null;
    }
  }

  // --- state ---------------------------------------------------------------

  const collectors = [new CameraCollector(), new AudioCollector(), new WifiCollector(), new LightCollector()];
  const series = {};
  const history = {};
  const rows = {};
  let run = null;
  let ticker = 0;
  /** Cycles in the run currently being recorded. */
  let cycleCount = CYCLES;
  /** Collectors this run is actually using. */
  let activeCollectors = [];

  function log(line) {
    const element = $('log');
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    element.textContent += `[${time}] ${line}\n`;
    element.scrollTop = element.scrollHeight;
  }

  // --- UI ------------------------------------------------------------------

  function buildSignalRows(inventory) {
    const host = $('signals');
    host.textContent = '';
    for (const collector of collectors) {
      const row = document.createElement('div');
      row.className = 'row';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = collector.name;

      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = '—';

      const canvas = document.createElement('canvas');
      canvas.width = 520;
      canvas.height = 34;

      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.title = collector.note || '';
      if (collector.skipped === true) {
        badge.textContent = '跳过';
      } else if (collector.available === true) {
        badge.textContent = 'on';
        badge.classList.add('ok');
      } else if (collector.available === false) {
        badge.textContent = 'off';
        badge.classList.add('bad');
      } else {
        // Not attempted yet: the camera and the microphone only open on start.
        badge.textContent = '待启动';
      }

      row.append(name, value, canvas, badge);
      host.append(row);
      rows[collector.name] = { value, canvas, badge };
      history[collector.name] = [];
    }

    const missing = collectors
      .filter((c) => c.available === false)
      .map((c) => `${c.name}: ${c.note || '不可用'}`);
    if (missing.length) log(`未启用的信号 -> ${missing.join(' | ')}`);

    $('inventory').innerHTML = inventory;
  }

  function drawSparkline(name) {
    const row = rows[name];
    if (!row) return;
    const canvas = row.canvas;
    const ctx = canvas.getContext('2d');
    const values = history[name];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (values.length < 2) return;

    let min = Infinity;
    let max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    const span = max - min || 1;
    ctx.beginPath();
    ctx.strokeStyle = '#5b8cff';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < values.length; i += 1) {
      const x = (i / (values.length - 1)) * canvas.width;
      const y = canvas.height - 2 - ((values[i] - min) / span) * (canvas.height - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const CAPACITY = 900;

  function pushSample(name, value, at) {
    series[name].push({ t: at, v: value });
    const buffer = history[name];
    buffer.push(value);
    if (buffer.length > CAPACITY) buffer.shift();
  }

  function refreshSparklines() {
    for (const name of Object.keys(rows)) drawSparkline(name);
  }

  // --- protocol ------------------------------------------------------------

  function phaseProgress(now) {
    if (!run || run.phaseIndex < 0) return 0;
    const phase = PHASES[run.phaseIndex];
    return Math.min(1, (now - run.phaseStartedAt) / phase.ms);
  }

  function enterPhase(index) {
    const now = Date.now();
    if (run.phaseIndex >= 0) {
      const previous = PHASES[run.phaseIndex];
      run.current.phases[`${previous.key}To`] = now;
    }
    run.phaseIndex = index;

    if (index >= PHASES.length) {
      run.cycles.push(run.current);
      run.cycleIndex += 1;
      if (run.cycleIndex >= cycleCount) { finishRun(); return; }
      run.current = { index: run.cycleIndex, phases: {} };
      run.phaseIndex = 0;
    }

    const phase = PHASES[run.phaseIndex];
    run.phaseStartedAt = Date.now();
    run.current.phases[`${phase.key}From`] = run.phaseStartedAt;
    if (phase.key === 'open') {
      // Each cycle measures the camera shift from its own starting point.
      const camera = collectors.find((c) => c.name === 'camera');
      if (camera && camera.reset) camera.reset();
    }
    cues.play(phase.cue);
    renderBanner();
  }

  function renderBanner() {
    if (!run) return;
    const phase = PHASES[run.phaseIndex];
    $('banner').textContent = `第 ${run.cycleIndex + 1} / ${cycleCount} 次 · ${phase.label}`;
    $('bannerHint').textContent = phase.hint;
  }

  async function startRun() {
    const cameraOnly = $('cameraOnly').checked;
    cycleCount = cameraOnly ? 3 : CYCLES;

    $('start').disabled = true;
    $('stop').disabled = false;
    $('save').disabled = true;
    $('log').textContent = '';
    $('verdict').textContent = '（记录中…）';

    cues.ensure();
    activeCollectors = collectors.filter((c) => (cameraOnly ? c.name === 'camera' : true));
    for (const collector of collectors) {
      collector.skipped = !activeCollectors.includes(collector);
    }

    let probeHz = null;
    if (cameraOnly) {
      log('只测摄像头：跳过音频扫描、探测音、Wi-Fi 与光照。');
    } else {
      log('开始：先做一次音频频响扫描，找到扬声器能被麦克风听见的最高频点');
      // A tone nobody can hear is the whole point, so prefer the highest
      // frequency that still loops back through the microphone.
      const scan = await AudioCollector.scan([14000, 16000, 17500, 18500, 19500, 20500]);
      if (scan.error) {
        log(`音频扫描失败: ${scan.error}`);
      } else {
        const table = scan.results
          .map((r) => `${(r.frequency / 1000).toFixed(1)}k=${Number.isFinite(r.level) ? r.level.toFixed(1) : 'n/a'}dB`)
          .join('  ');
        log(`频响扫描: ${table}`);
        const usable = scan.results.filter((r) => Number.isFinite(r.level) && r.level > -95);
        if (usable.length) {
          const best = usable.reduce((a, b) => (b.level > a.level ? b : a));
          probeHz = Math.max(...usable.map((r) => r.frequency));
          log(`选用探测音 ${(probeHz / 1000).toFixed(1)}kHz（该点回授 ${best.level.toFixed(1)}dB）`);
        } else {
          log('没有任何频点能被麦克风收到 —— 声学这一路不可用');
        }
      }
    }

    for (const collector of collectors) {
      series[collector.name] = [];
      collector.nextAt = 0;
    }

    for (const collector of activeCollectors) {
      if (collector.available === true) continue;
      if (typeof collector.start !== 'function') continue;
      if (collector.name === 'audio' && !probeHz) {
        collector.note = '没有找到可用的探测频点';
        collector.available = false;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await collector.start(probeHz);
      if (collector.available !== true && collector.note) log(`${collector.name}: ${collector.note}`);
    }

    const inventory = await bridge.inventory();
    buildSignalRows(inventory);
    for (const collector of collectors) {
      const row = rows[collector.name];
      if (!row) continue;
      row.badge.title = collector.note || '';
      if (collector.skipped) {
        row.badge.textContent = '跳过';
        row.badge.className = 'badge';
      } else if (collector.available === true) {
        row.badge.textContent = 'on';
        row.badge.className = 'badge ok';
      } else if (collector.available === false) {
        row.badge.textContent = 'off';
        row.badge.className = 'badge bad';
      }
    }

    const active = activeCollectors.filter((c) => c.available === true).map((c) => c.name).join(', ') || '无';
    log(`本次记录的信号: ${active}（${cycleCount} 次循环）`);

    run = {
      startedAt: Date.now(),
      cycleIndex: 0,
      phaseIndex: -1,
      phaseStartedAt: Date.now(),
      current: { index: 0, phases: {} },
      cycles: [],
    };
    enterPhase(0);

    let lastFlush = Date.now();
    const pending = [];
    ticker = window.setInterval(() => {
      const now = Date.now();

      for (const collector of activeCollectors) {
        if (collector.available !== true) continue;
        const next = collector.nextAt || 0;
        if (now < next) continue;
        collector.nextAt = now + collector.intervalMs;
        let value = null;
        try {
          value = collector.sample(now);
        } catch (error) {
          collector.available = false;
          log(`${collector.name} 失败: ${error.message}`);
          continue;
        }
        if (value === null || !Number.isFinite(value)) continue;
        pending.push({ name: collector.name, t: now, v: value });
        pushSample(collector.name, value, now);
        const row = rows[collector.name];
        if (!row) continue;
        row.value.textContent = value.toFixed(collector.digits) + ' ' + collector.unit;
        if (typeof collector.describe === 'function') {
          const text = collector.describe();
          if (text) row.badge.textContent = text;
        }
      }

      if (pending.length && now - lastFlush > 200) {
        bridge.samples(pending.splice(0, pending.length));
        lastFlush = now;
        refreshSparklines();
      }

      $('progress').style.width = `${((run.cycleIndex + phaseProgress(now) / PHASES.length) / cycleCount) * 100}%`;

      const phase = PHASES[run.phaseIndex];
      if (now - run.phaseStartedAt >= phase.ms) enterPhase(run.phaseIndex + 1);
    }, 25);
  }

  async function finishRun() {
    if (ticker) window.clearInterval(ticker);
    ticker = 0;
    if (run) {
      const last = PHASES[PHASES.length - 1];
      run.current.phases[`${last.key}To`] = Date.now();
    }
    $('banner').textContent = '记录完成';
    $('bannerHint').textContent = '正在分析…';
    $('progress').style.width = '100%';
    $('stop').disabled = true;
    $('save').disabled = false;

    for (const collector of collectors) if (collector.stop) collector.stop();

    const session = { series, cycles: run.cycles, startedAt: run.startedAt, endedAt: Date.now() };
    const report = await bridge.finish(session);
    log(report.savedTo ? `已保存: ${report.savedTo}` : '保存失败');
    renderVerdict(report);
    $('bannerHint').textContent = '分析完成，结果见下方的表格';
  }

  const VERDICT_TEXT = {
    'tracks the lid': '跟盖子走 ✅',
    'weak but promising': '能跟，但偏弱 ⚠️',
    'only part of the range': '只在部分区间跟 ⚠️',
    'not usable': '不可用 ❌',
    'no samples': '没采到数据',
    'no data': '没采到数据',
  };

  function renderVerdict(report) {
    const lines = [];
    for (const result of report.results) {
      const label = VERDICT_TEXT[result.verdict] || result.verdict;
      lines.push(
        `${result.name.padEnd(7)} ${label.padEnd(14)} `
        + `信噪比 ${Number.isFinite(result.snr) ? result.snr.toFixed(1).padStart(6) : '   n/a'}   `
        + `单调 ${result.monotone || 0}/${result.cycles || 0} 次   `
        + `可逆 ${result.reversing || 0}/${result.cycles || 0} 次`,
      );
    }
    lines.push('');
    lines.push(report.summary);
    $('verdict').textContent = lines.join('\n');
    log(report.summary);
  }

  // --- synthetic self test -------------------------------------------------

  if (SYNTHETIC) {
    window.__reconTest = {
      async prepare() {
        const camera = collectors.find((c) => c.name === 'camera');
        for (const collector of collectors) collector.skipped = collector !== camera;
        camera.available = null;
        await camera.start();
        camera.reset();
        buildSignalRows('synthetic self test');
        return true;
      },
      /**
       * Moves the scene by `pixelsPerStep` source pixels per step and samples
       * after each one, exactly the way the run loop does.
       */
      async run(steps, pixelsPerStep) {
        const camera = collectors.find((c) => c.name === 'camera');
        const tracker = camera.tracker;
        for (let i = 0; i < steps; i += 1) {
          tracker.offset += pixelsPerStep;
          camera.sample();
        }
        const sourceHeight = tracker.source.width * (tracker.height / tracker.width);
        return {
          steps,
          pixelsPerStep,
          total: Number(tracker.total.toFixed(3)),
          // Sliding the source window down the scene makes the scene move up the
          // frame, and the tracker counts a downward move as positive, so the
          // expectation is negative. Checking the sign here is deliberate: a
          // tracker that follows the lid backwards would still look plausible
          // until it was wired into the effect.
          expected: Number((-steps * pixelsPerStep * (tracker.height / sourceHeight)).toFixed(3)),
          quality: Number(tracker.quality.toFixed(3)),
          usedStrips: tracker.usedStrips,
        };
      },
    };
  }

  // --- boot ----------------------------------------------------------------

  (async () => {
    const inventory = await bridge.inventory();
    $('inventory').innerHTML = inventory;

    for (const collector of collectors) {
      if (collector.name === 'wifi' || collector.name === 'light') {
        // eslint-disable-next-line no-await-in-loop
        await collector.start();
      }
    }
    buildSignalRows(inventory);

    $('start').addEventListener('click', () => { startRun().catch((e) => log(`启动失败: ${e.message}`)); });
    $('stop').addEventListener('click', () => {
      if (ticker) window.clearInterval(ticker);
      ticker = 0;
      $('banner').textContent = '已中止';
      $('bannerHint').textContent = '';
      $('start').disabled = false;
      $('stop').disabled = true;
      log('用户中止');
    });
    $('save').addEventListener('click', async () => {
      const report = await bridge.finish({ series, cycles: run ? run.cycles : [] });
      log(report.savedTo ? `已重新保存: ${report.savedTo}` : '保存失败');
      renderVerdict(report);
    });
  })().catch((error) => {
    log(`初始化失败: ${error.message}`);
  });
})();
