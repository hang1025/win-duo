/* Win Duo - projective mapping. Loaded as a classic script, no build step. */
window.WinDuo = window.WinDuo || {};

(function (NS) {
  'use strict';

  /**
   * Maps the rectangle (0, 0)-(width, height) onto an arbitrary quadrilateral.
   *
   * Heckbert's square-to-quad solution, folded so that the caller can pass
   * picture coordinates directly: u = x / width, v = y / height.
   *
   * `corners` is bottom-left, bottom-right, top-right, top-left.
   *
   * Returns a column-major 3x3, ready for `uniformMatrix3fv` with
   * `transpose = false`: screen = matrix * (u, v, 1).
   */
  function rectToQuad(width, height, corners) {
    const [x0, y0] = corners[0];
    const [x1, y1] = corners[1];
    const [x2, y2] = corners[2];
    const [x3, y3] = corners[3];

    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const dy3 = y0 - y1 + y2 - y3;

    let g = 0;
    let h = 0;
    if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
      const determinant = dx1 * dy2 - dx2 * dy1;
      if (Math.abs(determinant) > 1e-12) {
        g = (dx3 * dy2 - dx2 * dy3) / determinant;
        h = (dx1 * dy3 - dx3 * dy1) / determinant;
      }
    }

    const a = x1 - x0 + g * x1;
    const b = x3 - x0 + h * x3;
    const c = x0;
    const d = y1 - y0 + g * y1;
    const e = y3 - y0 + h * y3;
    const f = y0;

    return [
      a / width, d / width, g / width,
      b / height, e / height, h / height,
      c, f, 1,
    ];
  }

  /** Inverse of a column-major 3x3. Returns null for a singular matrix. */
  function invert3(m) {
    // Column-major storage: m[col * 3 + row]. Name them row-major for the
    // textbook formula, then lay the result back out column by column.
    const a = m[0];
    const b = m[3];
    const c = m[6];
    const d = m[1];
    const e = m[4];
    const f = m[7];
    const g = m[2];
    const h = m[5];
    const i = m[8];

    const A = e * i - f * h;
    const B = c * h - b * i;
    const C = b * f - c * e;
    const D = f * g - d * i;
    const E = a * i - c * g;
    const F = c * d - a * f;
    const G = d * h - e * g;
    const H = b * g - a * h;
    const I = a * e - b * d;

    const det = a * A + b * D + c * G;
    if (Math.abs(det) < 1e-12) return null;
    const k = 1 / det;

    return [
      A * k, D * k, G * k,
      B * k, E * k, H * k,
      C * k, F * k, I * k,
    ];
  }

  NS.rectToQuad = rectToQuad;
  NS.invert3 = invert3;
})(window.WinDuo);
