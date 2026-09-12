/* Win Duo - a critically damped spring, so a stepped input ramps smoothly. */
window.WinDuo = window.WinDuo || {};

(function (NS) {
  'use strict';

  /**
   * Semi-implicit Euler stays stable while `frequency * dt` is below 2, which is
   * why the render loop clamps dt.
   */
  class Spring {
    constructor(value = 0, frequency = 16) {
      this.value = value;
      this.velocity = 0;
      this.frequency = frequency;
    }

    /** Radians per second. Higher follows the target faster and smooths less. */
    advance(target, dt, frequency) {
      const f = frequency === undefined ? this.frequency : frequency;
      const acceleration = f * f * (target - this.value) - 2 * f * this.velocity;
      this.velocity += acceleration * dt;
      this.value += this.velocity * dt;
    }

    /** Jumps to a value without a transient. Use when re-basing the effect. */
    reset(value) {
      this.value = value;
      this.velocity = 0;
    }
  }

  NS.Spring = Spring;
})(window.WinDuo);
