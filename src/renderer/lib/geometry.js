/* Win Duo - where the picture lands on the glass. */
window.WinDuo = window.WinDuo || {};

(function (NS) {
  'use strict';

  const DEG = Math.PI / 180;

  /**
   * The picture is a sheet hinged to the bottom edge of the screen, turned back
   * in world space by the angle the lid has travelled. The eye stays where it is
   * while the glass turns under it, so the projection takes both the current lid
   * angle and the eye position.
   *
   * `width` and `height` are the screen size in points; y points up, so y = 0 is
   * the hinge edge.
   *
   * Returns four points, bottom-left, bottom-right, top-right, top-left.
   */
  function corners(options) {
    const {
      startAngle,
      currentAngle,
      viewingDistance,
      recession,
      maxSeparationDegrees,
      width,
      height,
    } = options;

    const start = startAngle * DEG;
    const current = currentAngle * DEG;
    const travel = Math.max(startAngle - currentAngle, 0);
    const separation = Math.min(recession * travel, maxSeparationDegrees) * DEG;

    // The eye in world axes, hinge at the origin.
    const reach = height * viewingDistance + (height / 2) * Math.cos(start);
    const rise = (height / 2) * Math.sin(start);

    // The same eye, measured along the glass and away from it.
    const along = reach * Math.cos(current) + rise * Math.sin(current);
    const depth = Math.max(reach * Math.sin(current) - rise * Math.cos(current), height / 10);

    const half = width / 2;
    const sinSep = Math.sin(separation);
    const cosSep = Math.cos(separation);

    const project = (x, y) => {
      const scale = depth / (depth + y * sinSep);
      return [
        half + (x - half) * scale,
        along + (y * cosSep - along) * scale,
      ];
    };

    return [
      project(0, 0),
      project(width, 0),
      project(width, height),
      project(0, height),
    ];
  }

  NS.geometry = { corners };
})(window.WinDuo);
