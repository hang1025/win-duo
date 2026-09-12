/**
 * Analysis for a lid recon session.
 *
 * The session is a guided protocol: five cycles, each one closing the lid
 * slowly and opening it again with a pause at each end. Because the pauses are
 * where the lid is physically at a known place (fully open, fully shut), the
 * phase timings the recorder saved are the ground truth the signals are scored
 * against.
 *
 * Loaded both as a CommonJS module by the main process and as a classic script
 * by the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinDuoReconAnalyze = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mean(values) {
    if (!values.length) return NaN;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
  }

  function std(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    let acc = 0;
    for (const v of values) acc += (v - m) * (v - m);
    return Math.sqrt(acc / (values.length - 1));
  }

  function median(values) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Spearman rank correlation of [x, y] pairs. Returns NaN when undefined. */
  function spearman(pairs) {
    if (pairs.length < 4) return NaN;
    const n = pairs.length;
    const rank = (index) => {
      const order = pairs.map((_, i) => i).sort((a, b) => pairs[a][index] - pairs[b][index]);
      const ranks = new Array(n);
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && pairs[order[j + 1]][index] === pairs[order[i]][index]) j += 1;
        const average = (i + j) / 2 + 1;
        for (let k = i; k <= j; k += 1) ranks[order[k]] = average;
        i = j + 1;
      }
      return ranks;
    };
    const rx = rank(0);
    const ry = rank(1);
    const mx = mean(rx);
    const my = mean(ry);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i += 1) {
      num += (rx[i] - mx) * (ry[i] - my);
      dx += (rx[i] - mx) ** 2;
      dy += (ry[i] - my) ** 2;
    }
    if (dx === 0 || dy === 0) return NaN;
    return num / Math.sqrt(dx * dy);
  }

  function slice(samples, from, to) {
    return samples.filter((s) => s.t >= from && s.t < to);
  }

  function levels(samples, from, to) {
    return slice(samples, from, to).map((s) => s.v);
  }

  /**
   * Scores one signal against one cycle.
   *
   * The close phase is also split into thirds. A signal that only tracks the lid
   * over part of its travel - which is what the ambient light sensor would do,
   * since room light and screen light pull it in opposite directions - shows up
   * as one good third and two bad ones, and would be missed by scoring the close
   * as a whole.
   */
  function scoreCycle(samples, cycle) {
    const p = cycle.phases;
    const open = levels(samples, p.openFrom, p.openTo);
    const shut = levels(samples, p.shutFrom, p.shutTo);
    if (open.length < 3 || shut.length < 3) return null;

    const openLevel = median(open);
    const shutLevel = median(shut);
    const swing = shutLevel - openLevel;
    const noise = Math.max(std(open), std(shut), 1e-9);

    const close = slice(samples, p.closeFrom + 200, p.closeTo - 200);
    const reopen = slice(samples, p.reopenFrom + 200, p.reopenTo - 200);
    const closeRho = spearman(close.map((s) => [s.t, s.v]));
    const reopenRho = spearman(reopen.map((s) => [s.t, s.v]));

    // How far the value wandered while the lid was supposed to be held shut.
    // This is the number that decides whether the effect can sit on an angle
    // without creeping, so it is reported rather than folded into a score.
    const hold = levels(samples, p.shutFrom + 300, p.shutTo);
    const holdDrift = hold.length >= 2 ? Math.abs(hold[hold.length - 1] - hold[0]) : 0;

    const size = Math.floor(close.length / 3);
    const thirds = [0, 1, 2].map((i) => {
      const part = close.slice(i * size, i === 2 ? close.length : (i + 1) * size);
      const rho = spearman(part.map((s) => [s.t, s.v]));
      const values = part.map((s) => s.v);
      return {
        rho,
        // Movement within this third, relative to the noise floor.
        travel: values.length ? (Math.max(...values) - Math.min(...values)) / noise : 0,
      };
    });

    return {
      openLevel,
      shutLevel,
      swing,
      noise,
      snr: Math.abs(swing) / noise,
      closeRho,
      reopenRho,
      holdDrift,
      // Drift while held, as a fraction of the whole travel. A tracker that
      // creeps makes the effect move on its own.
      holdDriftRatio: holdDrift / Math.max(Math.abs(swing), 1e-9),
      // A signal that tracks the lid must run one way while closing and the
      // other way while opening.
      reverses: Number.isFinite(closeRho) && Number.isFinite(reopenRho)
        && Math.sign(closeRho) === -Math.sign(reopenRho),
      thirds,
    };
  }

  function verdictFor(cycles) {
    const usable = cycles.filter(Boolean);
    if (!usable.length) return { verdict: 'no data', score: 0 };

    const snr = median(usable.map((c) => c.snr));
    const holdDriftRatio = median(usable.map((c) => c.holdDriftRatio));
    const monotone = usable.filter((c) => Math.abs(c.closeRho) > 0.8).length;
    const reversing = usable.filter((c) => c.reverses && Math.abs(c.closeRho) > 0.8).length;
    const bestThird = Math.max(...usable.map((c) => Math.max(...c.thirds.map((t) => (
      Number.isFinite(t.rho) ? Math.abs(t.rho) * Math.min(t.travel, 1) : 0
    )))));

    // 80% of the cycles, and never fewer than three, so that a short run is
    // scored on the same terms as a long one.
    const need = Math.max(3, Math.ceil(usable.length * 0.8));
    const soft = Math.max(2, Math.ceil(usable.length * 0.6));

    let verdict = 'not usable';
    if (reversing >= need && monotone >= need && snr > 3 && holdDriftRatio < 0.25) {
      verdict = 'tracks the lid';
    } else if (reversing >= soft && snr > 2) {
      verdict = 'weak but promising';
    } else if (bestThird > 0.75 && snr > 2) {
      verdict = 'only part of the range';
    }

    return {
      verdict,
      score: reversing,
      snr,
      holdDriftRatio,
      monotone,
      reversing,
      bestThird,
      cycles: usable.length,
    };
  }

  function analyze(session) {
    const out = {};
    for (const [name, samples] of Object.entries(session.series)) {
      if (!samples.length) {
        out[name] = { name, verdict: 'no samples', score: 0, perCycle: [] };
        continue;
      }
      const perCycle = session.cycles.map((c) => scoreCycle(samples, c));
      out[name] = { name, perCycle, ...verdictFor(perCycle) };
    }
    return out;
  }

  return { analyze, mean, std, median, spearman, scoreCycle, verdictFor };
}));
