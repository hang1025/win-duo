'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULTS } = require('./defaults');

/**
 * User settings, backed by a JSON file in the Electron user data directory.
 *
 * Deliberately dependency-free: the project has to stay `npm install`-able
 * everywhere.
 */
class Preferences {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          this.values[key] = parsed[key];
        }
      }
    } catch (error) {
      // First run, or a file someone edited by hand. Defaults are already in.
      if (error && error.code !== 'ENOENT') {
        console.warn('[win-duo] settings unreadable, using defaults:', error.message);
      }
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.values, null, 2)}\n`);
    } catch (error) {
      console.error('[win-duo] could not save settings:', error.message);
    }
  }

  get all() {
    return { ...this.values };
  }

  /** Applies a patch, ignoring unknown keys. Returns the new settings. */
  update(patch) {
    if (!patch || typeof patch !== 'object') return this.all;
    for (const key of Object.keys(patch)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        this.values[key] = patch[key];
      }
    }
    this.save();
    return this.all;
  }

  reset() {
    this.values = { ...DEFAULTS };
    this.save();
    return this.all;
  }
}

module.exports = Preferences;
