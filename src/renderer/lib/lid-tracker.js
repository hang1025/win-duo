/*
 * Win Duo - lid angle tracking from the built-in webcam.
 *
 * Every laptop's webcam is rigidly fixed to the lid, so rotating the lid by Δθ
 * rotates the camera by Δθ, and the whole scene slides across the frame by
 * roughly f·tan(Δθ). At 640 px wide and a 60° field of view that is about nine
 * pixels per degree. That relationship is geometry, not chance: it holds
 * whatever else the machine is doing, which is exactly why this is the one
 * signal worth building on.
 *
 * The hard part is not the geometry, it is that the person closing the lid is
 * also in the frame, moving more than the lid does.
 *
 * Loaded as a classic script by both the overlay and the recon tool, so it has
 * no imports of its own.
 */
window.WinDuo = window.WinDuo || {};

(function (NS) {
  'use strict';

  /**
   * Cross-correlates two row-brightness profiles and returns the vertical shift
   * of the second relative to the first, with a parabolic sub-pixel refinement.
   *
   * Sign convention: positive means the scene moved DOWN the frame. Content at
   * row y+d in the first frame is at row y in the second, so `a[y]` matches
   * `b[y+s]` at `s = d`.
   */
  function bestShift(a, b, maxShift) {
    const scores = new Float32Array(maxShift * 2 + 1);
    let bestIndex = maxShift;
    let bestScore = -Infinity;

    for (let s = -maxShift; s <= maxShift; s += 1) {
      let n = 0;
      let meanA = 0;
      let meanB = 0;
      for (let y = 0; y < a.length; y += 1) {
        const yy = y + s;
        if (yy < 0 || yy >= b.length) continue;
        meanA += a[y];
        meanB += b[yy];
        n += 1;
      }
      if (n < a.length * 0.6) {
        scores[s + maxShift] = -Infinity;
        continue;
      }
      meanA /= n;
      meanB /= n;

      let numerator = 0;
      let sumA = 0;
      let sumB = 0;
      for (let y = 0; y < a.length; y += 1) {
        const yy = y + s;
        if (yy < 0 || yy >= b.length) continue;
        const va = a[y] - meanA;
        const vb = b[yy] - meanB;
        numerator += va * vb;
        sumA += va * va;
        sumB += vb * vb;
      }
      // Normalised, so a change of exposure between the frames cancels out.
      const score = sumA > 0 && sumB > 0 ? numerator / Math.sqrt(sumA * sumB) : -Infinity;
      scores[s + maxShift] = score;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = s + maxShift;
      }
    }

    let shift = bestIndex - maxShift;
    if (bestIndex > 0 && bestIndex < scores.length - 1) {
      const y0 = scores[bestIndex - 1];
      const y1 = scores[bestIndex];
      const y2 = scores[bestIndex + 1];
      const denominator = y0 - 2 * y1 + y2;
      if (Number.isFinite(y0) && Number.isFinite(y2) && Math.abs(denominator) > 1e-9) {
        shift += 0.5 * (y0 - y2) / denominator;
      }
    }
    return { shift, confidence: bestScore };
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * A deterministic scene with strong vertical texture, used by the self test so
   * the tracker can be checked against a known displacement without opening
   * anyone's camera.
   */
  function drawSyntheticScene(ctx, width, height) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#1a2740');
    gradient.addColorStop(0.5, '#3a2a30');
    gradient.addColorStop(1, '#16281f');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // A fixed LCG keeps the pattern identical between runs.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < 220; i += 1) {
      const level = Math.floor(60 + random() * 190);
      ctx.fillStyle = `rgb(${level},${level},${level})`;
      ctx.fillRect(random() * width, random() * height, 20 + random() * 90, 6 + random() * 26);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    for (let y = 0; y < height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
  }

  class LidTracker {
    constructor(options = {}) {
      this.width = options.width || 160;
      this.height = options.height || 120;
      this.strips = options.strips || 8;
      this.search = options.search || 6;
      // Below this the movement is correlation noise. Letting it through would
      // creep the angle while the lid is held still, which is the one thing the
      // effect must never do.
      this.deadband = options.deadband === undefined ? 0.08 : options.deadband;
      this.confidenceFloor = options.confidenceFloor === undefined ? 0.7 : options.confidenceFloor;
      this.varianceFloor = options.varianceFloor === undefined ? 4 : options.varianceFloor;
      this.synthetic = Boolean(options.synthetic);

      this.stripWidth = this.width / this.strips;
      this.total = 0;
      this.quality = 0;
      this.usedStrips = 0;
      this.available = false;
      this.note = '';
      this.previous = null;
      this.offset = 0;
    }

    async open() {
      if (this.synthetic) {
        this.source = document.createElement('canvas');
        this.source.width = 640;
        this.source.height = 960;
        drawSyntheticScene(this.source.getContext('2d'), this.source.width, this.source.height);
        this.offset = 0;
        this.available = true;
        this.note = 'synthetic';
      } else {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          });
        } catch (error) {
          this.note = `摄像头打不开: ${error.message}`;
          this.available = false;
          return false;
        }
        this.video = document.createElement('video');
        this.video.srcObject = this.stream;
        this.video.muted = true;
        this.video.playsInline = true;
        await this.video.play();
        this.available = true;
        this.note = '';
      }

      this.canvas = document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.reset();
      return true;
    }

    close() {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.available = false;
    }

    /** The angle origin is here: everything is measured from the last reset. */
    reset() {
      this.total = 0;
      this.previous = null;
      this.quality = 0;
      this.usedStrips = 0;
    }

    /** Accumulated travel since the last reset, in rows of the small canvas. */
    sample() {
      if (!this.available) return null;

      if (this.synthetic) {
        const sourceHeight = this.source.width * (this.height / this.width);
        this.ctx.drawImage(
          this.source,
          0, this.offset, this.source.width, sourceHeight,
          0, 0, this.width, this.height,
        );
      } else {
        this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
      }

      const { data } = this.ctx.getImageData(0, 0, this.width, this.height);

      const strips = [];
      for (let s = 0; s < this.strips; s += 1) {
        const from = Math.round(s * this.stripWidth);
        const to = Math.round((s + 1) * this.stripWidth);
        const profile = new Float32Array(this.height);
        let sum = 0;
        let sumSquares = 0;
        for (let y = 0; y < this.height; y += 1) {
          let acc = 0;
          for (let x = from; x < to; x += 1) {
            const i = (y * this.width + x) * 4;
            acc += (data[i] + data[i + 1] + data[i + 2]) / 3;
          }
          const value = acc / (to - from);
          profile[y] = value;
          sum += value;
          sumSquares += value * value;
        }
        strips.push({ profile, variance: sumSquares / this.height - (sum / this.height) ** 2 });
      }

      if (this.previous) {
        const shifts = [];
        let confidenceSum = 0;
        for (let s = 0; s < this.strips; s += 1) {
          // A flat strip (blank wall, dark ceiling) has nothing to correlate.
          if (strips[s].variance < this.varianceFloor) continue;
          const { shift, confidence } = bestShift(this.previous[s].profile, strips[s].profile, this.search);
          if (!Number.isFinite(shift) || confidence < this.confidenceFloor) continue;
          shifts.push(shift);
          confidenceSum += confidence;
        }
        this.usedStrips = shifts.length;
        if (shifts.length >= 3) {
          // The median is the point: a hand or a head only corrupts the strips it
          // covers, and a mean would be dragged by them.
          const middle = median(shifts);
          this.quality = confidenceSum / shifts.length;
          if (Math.abs(middle) > this.deadband) this.total += middle;
        }
      }

      this.previous = strips;
      return this.total;
    }

    /** Short status line, for a debug readout. */
    describe() {
      if (!this.available) return this.note || 'off';
      return `q${this.quality.toFixed(2)} ${this.usedStrips}/${this.strips}`;
    }
  }

  NS.LidTracker = LidTracker;
  NS.lidTracker = { bestShift, median, drawSyntheticScene };
})(window.WinDuo);
