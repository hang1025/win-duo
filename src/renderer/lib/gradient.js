/* Win Duo - how far out of focus the picture is, and how much light it lost. */
window.WinDuo = window.WinDuo || {};

(function (NS) {
  'use strict';

  function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  /**
   * `progress` runs 0 at the trigger angle to 1 once the lid has closed
   * `blurSpan` degrees past it.
   */
  function blurStrength(progress, curve) {
    return Math.pow(clamp01(progress), curve);
  }

  function dimStrength(progress, curve) {
    return Math.pow(clamp01(progress), curve);
  }

  NS.gradient = { blurStrength, dimStrength, clamp01 };
})(window.WinDuo);
