/* Win Duo - the settings panel. */
(function () {
  'use strict';

  const bridge = window.winDuoSettings;
  const all = window.WinDuoStrings;

  const lang = new URLSearchParams(window.location.search).get('lang') || 'en';
  const table = all[lang] || all.en;
  document.documentElement.lang = lang;

  /** Resolves a dotted key against the current language, then English. */
  function t(path) {
    const value = all.pick(table, path);
    return value === undefined ? all.pick(all.en, path) : value;
  }

  const SLIDERS = {
    'tracking-section': [
      { key: 'restAngle', min: 80, max: 130, step: 1, unit: '°' },
      { key: 'trackerGain', min: 0.3, max: 3, step: 0.05, unit: '×' },
      { key: 'fullTravel', min: 60, max: 400, step: 5, unit: 'row' },
    ],
    'angle-section': [
      { key: 'thresholdAngle', min: 40, max: 120, step: 1, unit: '°' },
      { key: 'blurSpan', min: 10, max: 100, step: 1, unit: '°' },
    ],
    'optics-section': [
      { key: 'viewingDistance', min: 1, max: 8, step: 0.1, unit: '×' },
      { key: 'recession', min: 0.2, max: 2, step: 0.05, unit: '×' },
      { key: 'maxBlurRadius', min: 0, max: 300, step: 5, unit: 'px' },
      { key: 'blurEvenness', min: 0, max: 1, step: 0.02 },
      { key: 'maxDim', min: 0, max: 1, step: 0.02 },
      { key: 'dimReach', min: 0.05, max: 1, step: 0.05 },
      { key: 'dimHingeFloor', min: 0, max: 1, step: 0.02 },
    ],
    'motion-section': [
      { key: 'sweepClosing', min: 0.3, max: 4, step: 0.1, unit: 's' },
      { key: 'sweepHold', min: 0, max: 3, step: 0.1, unit: 's' },
      { key: 'sweepOpening', min: 0.2, max: 3, step: 0.1, unit: 's' },
    ],
  };

  const controls = new Map();
  let applying = false;
  let saveTimer = 0;

  function format(value, spec) {
    const decimals = String(spec.step).includes('.') ? String(spec.step).split('.')[1].length : 0;
    const text = Number(value).toFixed(decimals);
    return spec.unit ? `${text} ${spec.unit}` : text;
  }

  function buildSlider(sectionId, spec) {
    const section = document.getElementById(sectionId);

    const row = document.createElement('div');
    row.className = 'row';

    const header = document.createElement('header');
    const label = document.createElement('label');
    label.textContent = t(`params.${spec.key}.label`);
    const value = document.createElement('span');
    value.className = 'value';
    header.append(label, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;

    input.addEventListener('input', () => {
      value.textContent = format(input.value, spec);
      scheduleSave(spec.key, Number(input.value));
    });

    row.append(header, input);

    const hint = t(`params.${spec.key}.hint`);
    if (hint) {
      const hintElement = document.createElement('div');
      hintElement.className = 'hint';
      hintElement.textContent = hint;
      row.append(hintElement);
    }

    section.append(row);
    controls.set(spec.key, { input, value, spec });
  }

  function scheduleSave(key, value) {
    if (applying) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { bridge.set({ [key]: value }); }, 120);
  }

  function apply(settings) {
    applying = true;

    for (const [key, control] of controls) {
      if (key in settings) {
        control.input.value = settings[key];
        control.value.textContent = format(settings[key], control.spec);
      }
    }

    for (const element of document.querySelectorAll('[data-key]')) {
      const key = element.dataset.key;
      if (!(key in settings)) continue;
      if (element.type === 'checkbox') element.checked = Boolean(settings[key]);
      else element.value = settings[key];
    }

    applying = false;
  }

  // Static text first, so the panel is readable even if a setting fails to load.
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const text = t(element.dataset.i18n);
    if (text !== undefined) element.textContent = text;
  }

  for (const [sectionId, specs] of Object.entries(SLIDERS)) {
    for (const spec of specs) buildSlider(sectionId, spec);
  }

  for (const element of document.querySelectorAll('[data-key]')) {
    const key = element.dataset.key;
    element.addEventListener('change', () => {
      if (applying) return;
      const value = element.type === 'checkbox' ? element.checked : element.value;
      bridge.set({ [key]: value });
    });
  }

  document.getElementById('preview').addEventListener('click', () => { bridge.preview(); });
  document.getElementById('reset').addEventListener('click', async () => {
    apply(await bridge.reset());
  });

  bridge.onSettings(apply);
  bridge.get().then(apply);
})();
