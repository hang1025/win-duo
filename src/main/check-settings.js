'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

const strings = require('../shared/strings');

/**
 * A smoke test for the settings page: it builds every control in both
 * languages, round-trips a value through the main process, and fails on any page
 * error.
 *
 * The page is the easiest place to break without noticing, because nothing else
 * in the project exercises it.
 *
 *   .\node_modules\.bin\electron.cmd . --check-settings
 */

function openPage(lang, errors) {
  const win = new BrowserWindow({
    width: 440,
    height: 660,
    show: false,
    backgroundColor: '#16171b',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`renderer gone: ${JSON.stringify(details)}`);
  });

  return win.loadFile(
    path.join(__dirname, '..', 'renderer', 'settings.html'),
    { query: { lang } },
  ).then(() => win);
}

const READ_PAGE = `(() => ({
  sliders: document.querySelectorAll('input[type="range"]').length,
  switches: document.querySelectorAll('[data-key]').length,
  sections: document.querySelectorAll('section').length,
  previewButton: Boolean(document.getElementById('preview')),
  resetButton: Boolean(document.getElementById('reset')),
  bridge: Boolean(window.winDuoSettings),
  lang: document.documentElement.lang,
  titles: Array.from(document.querySelectorAll('h1, section > h2, button, footer')).map((n) => n.textContent),
  labels: Array.from(document.querySelectorAll('.row label')).map((n) => n.textContent),
  hints: Array.from(document.querySelectorAll('.row .hint')).map((n) => n.textContent),
  empty: Array.from(document.querySelectorAll('[data-i18n]')).filter((n) => !n.textContent.trim()).length,
  firstSliderValue: (document.querySelector('input[type="range"]') || {}).value || null,
  monitor: (() => {
    const section = document.getElementById('monitor-section');
    if (!section) return null;
    return {
      label: (section.querySelector('h2') || {}).textContent || '',
      toggle: Boolean(section.querySelector('[data-key="persistentMonitor"]')),
      sliders: section.querySelectorAll('input[type="range"]').length,
      hint: (section.querySelector('.hint') || {}).textContent || '',
    };
  })(),
  cameraSelect: (() => {
    const select = document.getElementById('camera-device');
    return select ? {
      key: select.dataset.key,
      value: select.value,
      options: Array.from(select.options).map((option) => ({
        value: option.value,
        label: option.textContent,
      })),
    } : null;
  })(),
}))()`;

async function checkSettings({ prefs, wait }) {
  const problems = [];
  const errors = [];
  // Captured before anything is touched, so the finally below can put the
  // user's settings back even if a page call throws part way through.
  const original = prefs.all.maxBlurRadius;
  const originalCamera = prefs.all.cameraDeviceId;
  const originalMonitorTrigger = prefs.all.monitorTriggerAngle;
  let win = null;

  try {
    win = await openPage('en', errors);
  await wait(400);
  const english = await win.webContents.executeJavaScript(READ_PAGE);
  console.log(`en: ${JSON.stringify({ lang: english.lang, sliders: english.sliders, sections: english.sections, empty: english.empty })}`);
  console.log(`    titles: ${english.titles.filter(Boolean).join(' | ')}`);

  // Round-trip a changed value the way the page does, then put it back.
  const applied = await win.webContents.executeJavaScript(
    'window.winDuoSettings.set({ maxBlurRadius: 77 }).then((s) => s.maxBlurRadius)',
  );
  const stored = prefs.all.maxBlurRadius;
  console.log(`    round trip: page saw ${applied}, main stored ${stored}`);
  await win.webContents.executeJavaScript(`window.winDuoSettings.set({ maxBlurRadius: ${original} })`);

  // The camera picker has to build itself from a device list with no camera
  // present, so the smoke test supplies one through the page's own render path
  // rather than enumerateDevices.
  const fakeDevices = [
    { kind: 'videoinput', deviceId: 'cam-a', label: 'Logitech C920' },
    { kind: 'videoinput', deviceId: 'cam-b', label: '' },
    { kind: 'audioinput', deviceId: 'mic-a', label: 'Built-in microphone' },
  ];
  const renderCamera = (selectedId) => `(() => {
    window.__winDuoCameraDevices.override(${JSON.stringify(fakeDevices)}, ${JSON.stringify(selectedId)});
    const select = document.getElementById('camera-device');
    return {
      value: select.value,
      options: Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent })),
    };
  })()`;

  const cameraApplied = await win.webContents.executeJavaScript(
    'window.winDuoSettings.set({ cameraDeviceId: "cam-a" }).then((s) => s.cameraDeviceId)',
  );
  const cameraStored = prefs.all.cameraDeviceId;
  await wait(150);
  const present = await win.webContents.executeJavaScript(renderCamera('cam-a'));
  console.log(`    camera round trip: page saw ${cameraApplied}, main stored ${cameraStored}`);
  console.log(`    camera picker (present): ${JSON.stringify(present)}`);

  // A camera that was saved but has since been unplugged stays selected, as an
  // explicit entry, instead of the choice silently resetting.
  await win.webContents.executeJavaScript('window.winDuoSettings.set({ cameraDeviceId: "missing-cam" })');
  await wait(150);
  const missing = await win.webContents.executeJavaScript(renderCamera('missing-cam'));
  console.log(`    camera picker (saved missing): ${JSON.stringify(missing)}`);

  // Two enumerations in flight, the newer resolving first: the older result has
  // to be discarded rather than overwriting the newer list.
  const staleRender = await win.webContents.executeJavaScript(`(async () => {
    const media = navigator.mediaDevices;
    if (!media || typeof media.enumerateDevices !== 'function') return { skipped: true };
    window.__winDuoCameraDevices.override(null);
    const original = media.enumerateDevices;
    const oldList = [{ kind: 'videoinput', deviceId: 'old-cam', label: 'Old camera' }];
    const newList = [{ kind: 'videoinput', deviceId: 'new-cam', label: 'New camera' }];
    let calls = 0;
    let resolveOld = null;
    let resolveNew = null;
    media.enumerateDevices = () => {
      calls += 1;
      return new Promise((resolve) => {
        if (calls === 1) resolveOld = resolve;
        else resolveNew = resolve;
      });
    };
    media.dispatchEvent(new Event('devicechange'));
    media.dispatchEvent(new Event('devicechange'));
    if (typeof resolveOld === 'function' && typeof resolveNew === 'function') {
      resolveNew(newList);
      await new Promise((r) => setTimeout(r, 0));
      resolveOld(oldList);
      await new Promise((r) => setTimeout(r, 0));
    }
    media.enumerateDevices = original;
    const select = document.getElementById('camera-device');
    return { calls, values: Array.from(select.options).map((o) => o.value) };
  })()`);
  console.log(`    camera picker (stale enumeration): ${JSON.stringify(staleRender)}`);

  await win.webContents.executeJavaScript(
    `window.winDuoSettings.set({ cameraDeviceId: ${JSON.stringify(originalCamera)} })`,
  );
  await wait(100);

  // The automatic-monitor slider round-trips like any other. The toggle itself
  // is deliberately not flipped here: that would ask the main process to open a
  // camera during a smoke test that touches no hardware. The monitor's real
  // behaviour is covered by `--verify-monitor`.
  const monitorApplied = await win.webContents.executeJavaScript(
    'window.winDuoSettings.set({ monitorTriggerAngle: 21 }).then((s) => s.monitorTriggerAngle)',
  );
  const monitorStored = prefs.all.monitorTriggerAngle;
  await win.webContents.executeJavaScript(
    `window.winDuoSettings.set({ monitorTriggerAngle: ${originalMonitorTrigger} })`,
  );
  console.log(`    monitor round trip: page saw ${monitorApplied}, main stored ${monitorStored}`);

  // Same page again in Chinese, to catch a string that only exists in one table.
  await win.loadFile(
    path.join(__dirname, '..', 'renderer', 'settings.html'),
    { query: { lang: 'zh' } },
  );
  await wait(400);
  const chinese = await win.webContents.executeJavaScript(READ_PAGE);
  console.log(`zh: ${JSON.stringify({ lang: chinese.lang, sliders: chinese.sliders, sections: chinese.sections, empty: chinese.empty })}`);
  console.log(`    titles: ${chinese.titles.filter(Boolean).join(' | ')}`);

  if (!english.bridge || !chinese.bridge) problems.push('the settings page has no bridge');
  if (english.sliders < 12) problems.push(`only ${english.sliders} sliders rendered`);
  if (!english.previewButton || !english.resetButton) problems.push('a button is missing');
  if (english.empty || chinese.empty) problems.push(`${english.empty + chinese.empty} strings are empty`);
  if (english.lang !== 'en' || chinese.lang !== 'zh') problems.push('the language attribute was not set');
  if (english.titles.join() === chinese.titles.join()) problems.push('both languages rendered the same text');
  if (applied !== 77 || stored !== 77) problems.push('a setting did not round-trip');
  if (prefs.all.maxBlurRadius !== original) problems.push('the original value was not restored');
  if (errors.length) problems.push(`page errors: ${errors.join(' | ')}`);

  // The camera picker: it exists, keeps the system default, lists only video
  // inputs, names an unlabelled camera, and keeps a saved camera that is gone.
  if (!english.cameraSelect || english.cameraSelect.key !== 'cameraDeviceId') {
    problems.push('the camera selector is missing');
  }
  if (!chinese.cameraSelect) problems.push('the camera selector did not build in Chinese');
  if (cameraApplied !== 'cam-a' || cameraStored !== 'cam-a') {
    problems.push('the camera preference did not round-trip');
  }
  const presentOptions = (present && present.options) || [];
  const presentValues = presentOptions.map((option) => option.value);
  if (presentValues[0] !== '') problems.push('the system-default camera entry is missing');
  if (!presentValues.includes('cam-a')) problems.push('a present camera was not listed');
  if (!presentValues.includes('cam-b')) problems.push('a second camera was not listed');
  if (presentValues.includes('mic-a')) problems.push('an audio device leaked into the camera list');
  if (present && present.value !== 'cam-a') problems.push(`the saved camera was not selected (${present.value})`);
  const unlabelled = presentOptions.find((option) => option.value === 'cam-b');
  if (!unlabelled || !unlabelled.label.trim()) problems.push('a camera with no label had no generic name');
  const missingOptions = (missing && missing.options) || [];
  const missingEntry = missingOptions.find((option) => option.value === 'missing-cam');
  if (!missingEntry || !missingEntry.label.trim()) {
    problems.push('a saved but missing camera had no placeholder entry');
  }
  if (missing && missing.value !== 'missing-cam') {
    problems.push('the saved missing camera was not retained');
  }
  if (staleRender && !staleRender.skipped) {
    const staleValues = staleRender.values || [];
    if (staleRender.calls !== 2) problems.push('the devicechange listener did not run twice');
    if (!staleValues.includes('new-cam')) problems.push('the newer device list was not rendered');
    if (staleValues.includes('old-cam')) problems.push('a stale device list overwrote the newer one');
  }
  if (prefs.all.cameraDeviceId !== originalCamera) {
    problems.push('the camera preference was not restored');
  }

  // The automatic-monitor controls: a toggle and exactly two sliders, with a
  // hint that names the camera light, in both languages.
  if (!english.monitor || !english.monitor.toggle) {
    problems.push('the automatic-monitor toggle is missing');
  }
  if (english.monitor && english.monitor.sliders !== 2) {
    problems.push(`the automatic-monitor section has ${english.monitor.sliders} sliders`);
  }
  if (!chinese.monitor || chinese.monitor.sliders !== 2) {
    problems.push('the automatic-monitor sliders did not build in Chinese');
  }
  if (english.monitor && !/camera light/i.test(english.monitor.hint)) {
    problems.push('the English monitor hint does not warn about the camera light');
  }
  if (chinese.monitor && !chinese.monitor.hint.includes('摄像头')) {
    problems.push('the Chinese monitor hint does not mention the camera');
  }
  if (monitorApplied !== 21 || monitorStored !== 21) {
    problems.push('the monitor trigger did not round-trip');
  }
  if (prefs.all.monitorTriggerAngle !== originalMonitorTrigger) {
    problems.push('the monitor trigger was not restored');
  }

  // Every key the page asks for must exist in both tables.
  const keys = Object.keys(strings.en.params);
  for (const key of keys) {
    if (!strings.zh.params[key]) problems.push(`zh is missing params.${key}`);
  }
  // The camera strings are used from script, so the empty-text sweep cannot see
  // them; check each field explicitly in both languages.
  for (const field of ['label', 'default', 'generic', 'unavailable', 'hint']) {
    if (!strings.en.params.cameraDevice[field]) problems.push(`en is missing params.cameraDevice.${field}`);
    if (!strings.zh.params.cameraDevice[field]) problems.push(`zh is missing params.cameraDevice.${field}`);
  }
  // The automatic-monitor strings, both languages, label and hint each.
  for (const key of ['persistentMonitor', 'monitorTriggerAngle', 'monitorRearmAngle']) {
    for (const field of ['label', 'hint']) {
      if (!strings.en.params[key] || !strings.en.params[key][field]) {
        problems.push(`en is missing params.${key}.${field}`);
      }
      if (!strings.zh.params[key] || !strings.zh.params[key][field]) {
        problems.push(`zh is missing params.${key}.${field}`);
      }
    }
  }

    if (problems.length) {
      console.log(`FAIL: ${problems.join('; ')}`);
      return 1;
    }
    console.log('PASS: the settings page builds in both languages, round-trips a setting, and reports no errors.');
    return 0;
  } finally {
    // The page may have changed these before throwing; restore regardless, and
    // always take the window down.
    if (prefs.all.maxBlurRadius !== original) prefs.update({ maxBlurRadius: original });
    if (prefs.all.cameraDeviceId !== originalCamera) prefs.update({ cameraDeviceId: originalCamera });
    if (prefs.all.monitorTriggerAngle !== originalMonitorTrigger) {
      prefs.update({ monitorTriggerAngle: originalMonitorTrigger });
    }
    if (win && !win.isDestroyed()) win.destroy();
  }
}

module.exports = { checkSettings };
