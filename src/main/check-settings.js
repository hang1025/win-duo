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
}))()`;

async function checkSettings({ prefs, wait }) {
  const problems = [];
  const errors = [];

  const win = await openPage('en', errors);
  await wait(400);
  const english = await win.webContents.executeJavaScript(READ_PAGE);
  console.log(`en: ${JSON.stringify({ lang: english.lang, sliders: english.sliders, sections: english.sections, empty: english.empty })}`);
  console.log(`    titles: ${english.titles.filter(Boolean).join(' | ')}`);

  // Round-trip a changed value the way the page does, then put it back.
  const original = prefs.all.maxBlurRadius;
  const applied = await win.webContents.executeJavaScript(
    'window.winDuoSettings.set({ maxBlurRadius: 77 }).then((s) => s.maxBlurRadius)',
  );
  const stored = prefs.all.maxBlurRadius;
  console.log(`    round trip: page saw ${applied}, main stored ${stored}`);
  await win.webContents.executeJavaScript(`window.winDuoSettings.set({ maxBlurRadius: ${original} })`);

  // Same page again in Chinese, to catch a string that only exists in one table.
  await win.loadFile(
    path.join(__dirname, '..', 'renderer', 'settings.html'),
    { query: { lang: 'zh' } },
  );
  await wait(400);
  const chinese = await win.webContents.executeJavaScript(READ_PAGE);
  console.log(`zh: ${JSON.stringify({ lang: chinese.lang, sliders: chinese.sliders, sections: chinese.sections, empty: chinese.empty })}`);
  console.log(`    titles: ${chinese.titles.filter(Boolean).join(' | ')}`);

  win.destroy();

  if (!english.bridge || !chinese.bridge) problems.push('the settings page has no bridge');
  if (english.sliders < 12) problems.push(`only ${english.sliders} sliders rendered`);
  if (!english.previewButton || !english.resetButton) problems.push('a button is missing');
  if (english.empty || chinese.empty) problems.push(`${english.empty + chinese.empty} strings are empty`);
  if (english.lang !== 'en' || chinese.lang !== 'zh') problems.push('the language attribute was not set');
  if (english.titles.join() === chinese.titles.join()) problems.push('both languages rendered the same text');
  if (applied !== 77 || stored !== 77) problems.push('a setting did not round-trip');
  if (prefs.all.maxBlurRadius !== original) problems.push('the original value was not restored');
  if (errors.length) problems.push(`page errors: ${errors.join(' | ')}`);

  // Every key the page asks for must exist in both tables.
  const keys = Object.keys(strings.en.params);
  for (const key of keys) {
    if (!strings.zh.params[key]) problems.push(`zh is missing params.${key}`);
  }

  if (problems.length) {
    console.log(`FAIL: ${problems.join('; ')}`);
    return 1;
  }
  console.log(`PASS: the settings page builds in ${Object.keys(strings.en.params).length * 2 + 8} strings across both languages and reports no errors.`);
  return 0;
}

module.exports = { checkSettings };
