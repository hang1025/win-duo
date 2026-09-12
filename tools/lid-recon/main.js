'use strict';

/**
 * Lid signal recon - main process.
 *
 * Answers one question: is there any physical quantity on this laptop that
 * changes monotonically with the lid angle? There is no hinge sensor on a normal
 * Windows laptop, so this probes the signals that could stand in for one, drives
 * a timed protocol so the recordings are comparable, and scores them.
 *
 * Run with: npm run recon
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const { analyze } = require('./analyze');
const { SENSOR_INVENTORY, LIGHT_STREAM, encodeCommand } = require('./scripts');

const PAGE = path.join(__dirname, 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'lid-recon-output');

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

let window = null;
let lightProcess = null;
let lightValue = null;
let lightAt = 0;
let lightNote = 'not probed';
let wifiValue = null;
let wifiAt = 0;
let wifiNote = 'not probed';
let inventoryText = 'not probed';
let inventoryRaw = [];
let inventoryPromise = null;
const samples = {};

// ---------------------------------------------------------------------------
// PowerShell bridges
// ---------------------------------------------------------------------------

function powerShellOnce(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, out, err: `${err}\n(timeout)` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, out, err: error.message });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, out, err });
    });
  });
}

async function probeInventory() {
  if (process.platform !== 'win32') {
    inventoryText = 'not Windows; the sensor inventory only runs on Windows';
    return inventoryText;
  }

  const { out, err } = await powerShellOnce(SENSOR_INVENTORY);
  const present = [];
  const absent = [];
  let failed = null;

  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts.length < 2) continue;
    const [name, status] = parts;
    if (status === 'PRESENT') {
      present.push({ name, via: parts[2], device: parts[3] });
      inventoryRaw.push({ name, status, via: parts[2], device: parts[3] });
    } else {
      absent.push(name);
      inventoryRaw.push({ name, status });
    }
  }

  if (!present.length && !absent.length) failed = err.trim() || 'no output';

  const lines = [];
  lines.push('<b>Windows 传感器清单</b>');
  if (failed) {
    lines.push(`探测失败: ${failed}`);
    lines.push('（这不影响其余信号的采集）');
  } else if (present.length) {
    for (const sensor of present) {
      lines.push(`✅ ${sensor.name}  →  ${sensor.device || '(no id)'}`);
    }
  } else {
    lines.push(`❌ 这台机器上 0 / ${absent.length} 个 Windows 传感器类有实例。`);
    lines.push('   也就是说：没有铰链角度传感器，也没有环境光传感器。');
  }
  inventoryText = lines.join('\n');

  // Only worth starting if there is something to read.
  if (present.some((s) => s.name === 'LightSensor')) {
    startLightStream();
  } else {
    lightNote = '这台机器没有暴露环境光传感器';
  }
  return inventoryText;
}

function startLightStream() {
  if (lightProcess) return;
  lightNote = 'starting';
  lightProcess = spawn(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(LIGHT_STREAM)],
    { windowsHide: true },
  );

  let buffer = '';
  lightProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const text = line.trim();
      if (text === 'ABSENT') { lightNote = 'no light sensor'; continue; }
      if (text === 'OK') { lightNote = ''; continue; }
      if (text === 'ERR') { lightNote = 'read failed'; continue; }
      const value = Number.parseFloat(text);
      if (Number.isFinite(value)) {
        lightValue = value;
        lightAt = Date.now();
      }
    }
  });
  lightProcess.on('error', (error) => { lightNote = error.message; });
  lightProcess.on('close', () => { lightProcess = null; });
}

let wifiTimer = 0;

function pollWifi() {
  if (process.platform !== 'win32') {
    wifiNote = 'not Windows';
    return;
  }
  const child = spawn('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.on('error', (error) => { wifiNote = error.message; });
  child.on('close', () => {
    // Locale independent: the signal line is the one carrying a percentage.
    const match = out.match(/:\s*(\d{1,3})\s*%/);
    if (match) {
      wifiValue = Number.parseInt(match[1], 10);
      wifiAt = Date.now();
      wifiNote = '';
      return;
    }
    // An empty result means this poll failed, not that the adapter is gone.
    // Keep the previous note rather than flipping to a wrong one.
    if (!out.trim()) return;
    const state = out.match(/State\s*:\s*(\S+)/i);
    wifiNote = state
      ? `无线网卡 ${state[1]}，未连接（RSSI 要连上 AP 才读得到）`
      : '读到了无线网卡，但没有连接信息';
  });
}

function startWifiPoller() {
  pollWifi();
  wifiTimer = setInterval(pollWifi, 500);
}

// ---------------------------------------------------------------------------
// Session output
// ---------------------------------------------------------------------------

function writeSession(session, report) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(OUTPUT_DIR, `recon-${stamp}`);

  const rows = [];
  for (const [name, list] of Object.entries(session.series || {})) {
    for (const sample of list) rows.push({ name, t: sample.t - session.startedAt, v: sample.v });
  }
  rows.sort((a, b) => a.t - b.t);
  const csv = ['t_ms,signal,value', ...rows.map((r) => `${r.t},${r.name},${r.v}`)].join('\n');
  fs.writeFileSync(`${base}.csv`, `${csv}\n`);

  fs.writeFileSync(`${base}.json`, `${JSON.stringify({
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    inventory: inventoryRaw,
    cycles: session.cycles,
    report,
    series: session.series,
  }, null, 2)}\n`);

  return base;
}

function summarize(report) {
  const results = report.results || [];
  const usable = results.filter((r) => r.verdict === 'tracks the lid');
  const partial = results.filter((r) => r.verdict === 'only part of the range' || r.verdict === 'weak but promising');

  if (usable.length) {
    return `结论：${usable.map((r) => r.name).join('、')} 在合盖时单调变化、开盖时反向回来。`
      + '这条信号可以用作角度源——下一步是标定它，并验证在 105°→65° 这段里的分辨率。';
  }
  if (partial.length) {
    return `结论：${partial.map((r) => r.name).join('、')} 有跟随迹象但不干净。`
      + '先看 output 里的曲线是否在某个区间内单调；如果是，可以只在那个区间里用。';
  }
  return '结论：没有任何信号随盖子单调变化。'
    + '这说明在这台机器上，纯软件拿不到连续的角度——只能走手动控制或加装硬件。';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('recon:inventory', () => inventoryPromise);

  ipcMain.handle('recon:wifi', () => (
    wifiValue !== null && Date.now() - wifiAt < 2000
      ? { value: wifiValue }
      : { value: null, note: wifiNote }
  ));

  ipcMain.handle('recon:light', () => (
    lightValue !== null && Date.now() - lightAt < 1000
      ? { available: true, value: lightValue }
      : { available: false, value: null, note: lightNote }
  ));

  ipcMain.on('recon:samples', (_event, batch) => {
    for (const sample of batch) {
      if (!samples[sample.name]) samples[sample.name] = [];
      samples[sample.name].push({ t: sample.t, v: sample.v });
    }
  });

  ipcMain.on('recon:log', (_event, line) => { console.log(`[recon] ${line}`); });

  ipcMain.handle('recon:finish', (_event, session) => {
    // Merge anything the renderer did not send, then analyse.
    for (const [name, list] of Object.entries(samples)) {
      if (!session.series[name] || !session.series[name].length) session.series[name] = list;
    }
    const report = analyze(session);
    const results = Object.values(report).sort((a, b) => (b.score || 0) - (a.score || 0));
    const full = { results, summary: '' };
    full.summary = summarize(full);

    let savedTo = null;
    try {
      savedTo = writeSession(session, full);
    } catch (error) {
      console.error('[recon] could not save:', error.message);
    }

    console.log(`[recon] ${full.summary}`);
    for (const r of results) {
      console.log(`[recon] ${r.name}: ${r.verdict} (snr ${r.snr}, monotone ${r.monotone}/${r.cycles}, reversing ${r.reversing}/${r.cycles})`);
    }
    if (savedTo) console.log(`[recon] saved ${savedTo}.csv / .json`);

    return { results, summary: full.summary, savedTo };
  });
}

function configurePermissions() {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

/**
 * Reports the synthetic camera self test.
 *
 * The scene is moved by a known number of source pixels and the tracker has to
 * report that same movement back. A closing lid only ever travels one way, so
 * the second pass runs the scene backwards: the total must come home to zero.
 * This is what separates "the maths is wrong" from "the camera did not open".
 */
function reportCameraSelftest(forward, backward) {
  const tolerance = Math.max(1.5, Math.abs(forward.expected) * 0.02);
  const error = Math.abs(forward.total - forward.expected);
  console.log(
    `[recon] forward : tracked ${forward.total} rows, injected ${forward.expected} rows `
    + `(error ${error.toFixed(2)}, quality ${forward.quality}, strips ${forward.usedStrips}/8)`,
  );
  console.log(`[recon] backward: total came home to ${backward.total} rows`);
  const pass = error <= tolerance && Math.abs(backward.total) <= tolerance && forward.usedStrips >= 3;
  console.log(pass
    ? '[recon] PASS: the tracker follows a known shift and returns to where it started.'
    : '[recon] FAIL: the tracked shift does not match the injected one.');
  return pass;
}

async function onReady() {
  configurePermissions();
  registerIpc();

  // Started before the page loads: the page awaits this promise on boot, so it
  // must exist by the time the renderer first asks.
  inventoryPromise = probeInventory();

  window = new BrowserWindow({
    width: 940,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: 'Lid signal recon',
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.log(`[recon:page] ${message} (${source}:${line})`);
  });

  // `--camera-selftest`: drive the tracker with a generated scene instead of a
  // camera, and check the tracked shift against the injected one.
  const cameraSelftest = process.argv.includes('--camera-selftest');
  await window.loadFile(PAGE, cameraSelftest ? { query: { synthetic: '1' } } : undefined);

  if (cameraSelftest) {
    await new Promise((r) => setTimeout(r, 600));
    const forward = await window.webContents.executeJavaScript(
      'window.__reconTest.prepare().then(() => window.__reconTest.run(60, 4))',
    );
    const backward = await window.webContents.executeJavaScript('window.__reconTest.run(60, -4)');
    app.exit(reportCameraSelftest(forward, backward) ? 0 : 1);
    return;
  }

  startWifiPoller();
  const text = await inventoryPromise;
  console.log('[recon] sensor inventory:\n' + String(text).replace(/<\/?b>/g, ''));

  // `--shot <path>`: screenshot the window and quit, for checking the panel
  // renders without sitting in front of it.
  const shotIndex = process.argv.indexOf('--shot');
  if (shotIndex !== -1 && process.argv[shotIndex + 1]) {
    const target = process.argv[shotIndex + 1];
    await new Promise((r) => setTimeout(r, 2500));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(target, image.toPNG());
    console.log(`[recon] wrote ${target}`);
    app.exit(0);
  }
}

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => {
  if (lightProcess) lightProcess.kill();
  if (wifiTimer) clearInterval(wifiTimer);
});

app.whenReady().then(() => {
  onReady().catch((error) => {
    console.error('[recon] startup failed:', error);
    app.exit(1);
  });
});
