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
  // Which video input the camera tracker opens, as a MediaDevices device id.
  // '' means the system default. A saved id that is no longer connected makes
  // the tracker fall back to the default camera for the run, and then to the
  // sweep if even that fails.
  cameraDeviceId: '',

  // --- Persistent monitor ------------------------------------------------
  // Off by default, and deliberately so: when on, the overlay keeps one camera
  // stream open between runs so a close can start the fold without the hotkey.
  // The camera light then stays on the whole time, which is a real privacy
  // cost and exactly why this is opt-in.
  persistentMonitor: false,
  // Relative degrees of lid travel below the position the lid was at when the
  // monitor started. This is NOT an absolute hinge angle: the zero point is
  // wherever the lid happened to be when monitoring began. A complete close is
  // about restAngle degrees of travel, so 12 is a small part of one.
  monitorTriggerAngle: 12,
  // The relative angle the lid must come back within, after a run, before the
  // monitor will trigger again. Kept below monitorTriggerAngle for hysteresis,
  // so a lid resting near the trigger cannot fire over and over.
  monitorRearmAngle: 5,
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
  // Fraction of fullTravel that counts as "the lid is moving", and, once folded,
  // as "back at rest".
  engageFraction: 0.03,
  // Below this much travel, after a real close, the lid counts as back at rest.
  releaseFraction: 0.1,
  // How the fold follows the lid back down. Closing follows instantly; opening
  // follows through a first-order lag with this time constant, so tracker noise
  // and the brief reversal part way through a close cannot move the picture,
  // while a real unfold glides instead of stepping.
  //
  // A hold-then-release ratchet was tried here and was worse: it froze the
  // picture and then jumped about a fifth of the travel at a time, which read as
  // the blur snapping rather than travelling.
  releaseFollowSeconds: 0.25,
  // Degrees either side of `restAngle` where the picture stays perfectly flat,
  // so the lid can sit at a working angle without any blur at all.
  neutralBand: 0,
  // 'auto' ends the run when the lid comes back to rest or after the idle
  // timeout. 'key' keeps it up until Escape is pressed, and turns the idle and
  // stuck caps off entirely - the camera stays on until then. Escape always ends
  // a run, either way.
  releaseOn: 'auto',
  // Armed with no lid movement for this long, or armed at all for this long,
  // and the camera goes back off.
  idleReleaseMs: 15000,
  maxArmedMs: 300000,
  // Radians per second of the spring that smooths the tracked progress.
  trackerSpringFrequency: 16,
  // The same spring, speeded up for the ease back to flat when a run ends. At
  // the tracking frequency the ease alone takes about half a second, because a
  // critically damped spring needs four or five time constants to settle - and
  // that is exactly what a click-to-exit feels like: half a second of nothing.
  releaseSpringFrequency: 45,
  // And a shorter fade after an explicit click, which is the case where waiting
  // is least welcome.
  clickFadeOut: 0.12,
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
  // travel. 1 pins the picture to the room instead of to the glass; 0 keeps it
  // glued flat.
  //
  // 0.4 is where this was tuned to by eye on a real laptop: at 1 the picture
  // swings away far too fast and the fold reads as a swoop rather than a bend.
  recession: 0.4,
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
  // screen height, measured from the hinge edge. Below 1 the dimming saturates
  // part way up and the top of the picture goes uniformly dark, which reads as a
  // black band rather than a gradient.
  dimReach: 0.9,
  // Dimming at the hinge edge, as a fraction of the dimming at the far edge.
  dimHingeFloor: 0.2,
  // Exponent on the closing travel. Above 1 starts slowly, which makes the blur
  // arrive late and then rush; 1 spreads it evenly across the fold.
  blurCurve: 1,
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

/**
 * Clamps a possibly-missing numeric setting without ever returning NaN.
 * A settings file edited by hand, or an IPC patch from a page, can hold a
 * string, null or NaN; none of those may reach the monitor maths.
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * The persistent-monitor angles, clamped to sane ranges. The rearm angle is
 * forced strictly below the trigger so hysteresis always exists, whatever a
 * hand-edited settings.json holds. Pure, so the policy can be checked without
 * a camera or a window.
 */
function monitorAngles(settings) {
  const source = settings || {};
  const triggerAngle = clampNumber(source.monitorTriggerAngle, 1, 90, 12);
  const rearmAngle = clampNumber(source.monitorRearmAngle, 0, triggerAngle - 0.5, 5);
  return { triggerAngle, rearmAngle };
}

module.exports = { DEFAULTS, sweepOpenAngle, sweepShutAngle, clampNumber, monitorAngles };
