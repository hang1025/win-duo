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

  // --- Angle source ------------------------------------------------------
  // 'camera' follows the real lid through the built-in webcam; 'sweep' plays
  // the scripted animation. The camera falls back to the sweep by itself if it
  // cannot be opened.
  angleSource: 'camera',
  // Degrees the lid stands at when the effect arms. A 16" laptop flat on a desk
  // faces a seated user at roughly this angle, and the effect's trigger angle
  // should match it, so that closing the lid an inch starts the fold.
  restAngle: 105,
  // Tracker rows for a close from restAngle to shut. Only a first guess: it is
  // re-learned from every complete close, because how far the scene slides
  // depends on the camera, the room and how the user sits.
  fullTravel: 170,
  // The angle the fold finishes at, and it holds there as the lid keeps going.
  // About 50 degrees is as far as the effect is ever worth showing: it is where
  // the reference clip bottoms out, and it is roughly where a laptop panel stops
  // being readable anyway. Letting the fold follow the lid past this buries the
  // picture under its own black.
  foldAngle: 50,
  // Multiplier on the tracked travel, for taste.
  trackerGain: 1,
  // Fraction of fullTravel that counts as "the lid is moving" and, once folded,
  // as "back at rest".
  engageFraction: 0.03,
  // How far the travel has to reverse before it counts as a reversal at all,
  // and how long the reversal has to hold before the fold follows it back. The
  // camera stops looking at the room and starts looking at the keyboard part way
  // through a close, and that changes the apparent direction for a moment;
  // without this the fold would jump backwards mid-close.
  retraceFraction: 0.03,
  retraceHoldMs: 350,
  // Below this much travel, after a real close, the lid is back at rest.
  retraceReleaseFraction: 0.1,
  // Armed with no lid movement for this long, or armed at all for this long,
  // and the camera goes back off.
  idleReleaseMs: 15000,
  maxArmedMs: 300000,
  // Radians per second of the spring that smooths the tracked progress.
  trackerSpringFrequency: 16,
  // Draw the tracked angle in the corner, for checking the tracking by eye.
  showAngleReadout: true,

  // --- Angle -------------------------------------------------------------
  // The angle the fold starts at. With the camera as the angle source this is
  // taken from `restAngle` instead, so that the fold begins the moment the lid
  // moves.
  //
  // 100 rather than Mac Duo's 90: a laptop flat on a desk faces a seated user
  // at about 105 degrees, so 90 is already well past the point where the panel
  // starts washing out.
  thresholdAngle: 100,
  // Degrees of lid travel from the trigger angle to full blur. Measured against
  // a flat-on-desk setup, the screen stops being readable around 60-65 degrees,
  // so the effect has to finish its work before then.
  blurSpan: 40,
  // Degrees the picture turns away from the glass for each degree of lid
  // travel. 1 pins the picture to the room instead of to the glass.
  recession: 1,
  // Past this the picture would turn its face away from the glass.
  maxSeparationDegrees: 88,

  // --- Optics ------------------------------------------------------------
  // Eye distance from the middle of the screen, as a multiple of the screen
  // height. Higher is a flatter, weaker perspective. 3 is what a seated user at
  // a laptop flat on a desk actually measures: eyes roughly 60 cm from the
  // hinge, screen height 21.5 cm. Mac Duo ships 6, which assumes a much
  // stronger viewing distance than a laptop on a desk ever has.
  viewingDistance: 3,
  // Gaussian blur radius at full effect, in points. Matched against the
  // reference clip: by its deepest frame the icons are soft blobs, so this is
  // deliberately heavy. Lower it if you would rather keep reading the screen.
  maxBlurRadius: 90,
  // Blur at the hinge edge as a fraction of the blur at the far edge. 0 leaves
  // the hinge edge sharp, 1 blurs the picture evenly.
  blurEvenness: 0,
  // Black overlay opacity where the blur is at full strength, 0...1.
  maxDim: 0.85,
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
