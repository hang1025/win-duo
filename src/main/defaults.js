'use strict';

/**
 * Every tunable, in one place.
 *
 * The defaults are ported from Mac-Duo (Apache-2.0, (c) 2026 Makito) so that
 * this port matches the reference implementation out of the box.
 *
 * Angles are in degrees. Lengths are in points (CSS px), never device px; the
 * renderer multiplies by the display scale factor where it needs to.
 */
const DEFAULTS = {
  enabled: true,

  // --- Angle -------------------------------------------------------------
  // The effect arms once the lid passes below this angle. 90 is a lid standing
  // straight up out of the base.
  thresholdAngle: 90,
  // Degrees below the threshold for the blur to reach full strength.
  blurSpan: 60,
  // Degrees the picture turns away from the glass for each degree of lid
  // travel. 1 pins the picture to the room instead of to the glass.
  recession: 1,
  // Past this the picture would turn its face away from the glass.
  maxSeparationDegrees: 88,

  // --- Optics ------------------------------------------------------------
  // Eye distance from the middle of the screen, as a multiple of the screen
  // height. Higher is a flatter, weaker perspective.
  viewingDistance: 6,
  // Gaussian blur radius at full effect, in points.
  maxBlurRadius: 135,
  // Blur at the hinge edge as a fraction of the blur at the far edge. 0 leaves
  // the hinge edge sharp, 1 blurs the picture evenly.
  blurEvenness: 0,
  // Black overlay opacity where the blur is at full strength, 0...1.
  maxDim: 1,
  // Height at which the dimming reaches full strength, as a fraction of the
  // screen height, measured from the hinge edge.
  dimReach: 0.5,
  // Dimming at the hinge edge, as a fraction of the dimming at the far edge.
  dimHingeFloor: 0.2,
  // Exponent on the closing travel. Above 1 starts slowly.
  blurCurve: 1.6,
  dimCurve: 0.7,
  // Black margin around the picture, in points. Must stay above the largest
  // blur radius so the blur reaches real black on every side.
  paddingPoints: 120,

  // --- Motion ------------------------------------------------------------
  // Radians per second of the critically damped spring that turns a sampled
  // angle into a per-frame value.
  springFrequency: 16,
  // The scripted sweep that stands in for a lid angle sensor. It starts
  // `sweepFromMargin` above the threshold (capped at `sweepMaxOpen`), closes to
  // `threshold - blurSpan * sweepOvershoot`, holds, then opens back up.
  //
  // The defaults deliberately stop well short of a shut lid. Past roughly 45
  // degrees the picture is mostly black, which is right for a real lid that is
  // nearly closed but reads as a glitch when nothing is physically moving. See
  // `selftest-output/` for what each angle looks like.
  sweepFromMargin: 20,
  sweepMaxOpen: 130,
  sweepOvershoot: 0.75,
  sweepClosing: 1.2,
  sweepHold: 0.5,
  sweepOpening: 0.8,
  // Seconds. Kept short so the flat first frame lands on top of an unchanged
  // desktop with no visible seam.
  fadeIn: 0.07,
  fadeOut: 0.22,

  // --- Shell -------------------------------------------------------------
  hotkey: 'Control+Alt+D',
  launchAtLogin: false,
  // Which display the effect covers: 'primary' or 'cursor'.
  displayMode: 'primary',
};

/** The angle the scripted sweep starts at. */
function sweepOpenAngle(prefs) {
  return Math.min(prefs.thresholdAngle + prefs.sweepFromMargin, prefs.sweepMaxOpen);
}

/** The angle the scripted sweep closes to. */
function sweepShutAngle(prefs) {
  return Math.max(prefs.thresholdAngle - prefs.blurSpan * prefs.sweepOvershoot, 5);
}

module.exports = { DEFAULTS, sweepOpenAngle, sweepShutAngle };
