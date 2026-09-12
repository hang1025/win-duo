/* Win Duo - the whole effect, in one fragment shader. */
window.WinDuo = window.WinDuo || {};

(function (NS) {
  'use strict';

  /**
   * Each screen pixel maps back into the picture through the inverse
   * perspective, then takes one sample from the mip pyramid at a level chosen by
   * the blur wanted there. The texture already holds the picture on black, so
   * the two blur together and the picture edge needs no special handling.
   *
   * Two things differ from the Metal original on purpose:
   *
   * 1. `textureLod` replaces `sample(..., level(m))`. WebGL2 lets the sampler
   *    interpolate between the two nearest levels, which hides the blockiness a
   *    halving pyramid would otherwise show at large radii.
   *
   * 2. The dimming multiplies the sampled colour directly instead of raising the
   *    factor to 2.2. The original samples an `_srgb` texture, so its maths runs
   *    in linear light and `pow(1 - maxDim * fade, 2.2)` cancels back out to a
   *    plain scale of the *encoded* value. Here the texture is never decoded, so
   *    the encoded-space factor is the whole story.
   *
   * One thing that is easy to get wrong here, and was: everything outside the
   * picture must be OPAQUE BLACK at full opacity, not transparent. The window is
   * transparent so that it can fade, and the fold contracts the picture away
   * from the edges of the screen - so a transparent "outside" lets the untouched
   * desktop show through the gaps, sharp and un-warped, which reads as the
   * effect leaking its own wallpaper back at you.
   */
  const FRAGMENT = `#version 300 es
precision highp float;

uniform mat3  uScreenToPicture;  // screen point -> picture point, both in points, y up
uniform vec2  uScreenSize;       // screen size in points
uniform vec2  uPaddedOrigin;     // the padded picture's origin, in points
uniform vec2  uPaddedSize;       // screen size plus the black margin
uniform float uPixelScale;       // device px per point
uniform float uMaxRadius;        // blur radius at full strength, in device px
uniform float uBlurStrength;     // 0...1
uniform float uBlurFloor;        // blur at the hinge edge, as a fraction
uniform float uMaxLevel;         // highest mip level
uniform float uDimHingeFloor;    // dimming at the hinge edge, as a fraction
uniform float uDimStrength;      // 0...1
uniform float uDimReach;         // height at which dimming saturates
uniform float uMaxDim;           // black opacity at full strength
uniform float uOpacity;          // overlay fade, premultiplied

uniform sampler2D uPicture;

out vec4 fragColor;

void main() {
  // gl_FragCoord is device pixels with y up, which is the frame the geometry is
  // expressed in. This is the mirror of the original's
  // (position.x, screenSize.y - position.y) dance for a y-down view.
  vec2 screenPoint = gl_FragCoord.xy / uPixelScale;

  vec3 mapped = uScreenToPicture * vec3(screenPoint, 1.0);
  if (abs(mapped.z) < 1e-6) { fragColor = vec4(0.0, 0.0, 0.0, uOpacity); return; }
  vec2 picturePoint = mapped.xy / mapped.z;

  vec2 unit = (picturePoint - uPaddedOrigin) / uPaddedSize;
  if (unit.x < 0.0 || unit.x > 1.0 || unit.y < 0.0 || unit.y > 1.0) {
    // Opaque black, not transparent: see the note above the shader.
    fragColor = vec4(0.0, 0.0, 0.0, uOpacity);
    return;
  }
  vec2 texCoord = vec2(unit.x, 1.0 - unit.y);

  float height = clamp(picturePoint.y / uScreenSize.y, 0.0, 1.0);
  float blur = uBlurStrength * (uBlurFloor + (1.0 - uBlurFloor) * height);
  float mipLevel = clamp(log2(max(blur * uMaxRadius, 1.0)), 0.0, uMaxLevel);

  vec4 colour = textureLod(uPicture, texCoord, mipLevel);

  // smoothstep rather than a clamped ratio, so the height where the dimming
  // reaches full strength leaves no visible edge.
  float spread = smoothstep(0.0, max(uDimReach, 0.02), height);
  float fade = uDimStrength * (uDimHingeFloor + (1.0 - uDimHingeFloor) * spread);
  colour.rgb *= (1.0 - uMaxDim * fade);

  // The context is premultiplied, and the window has to stay see-through while
  // it fades.
  fragColor = vec4(colour.rgb * uOpacity, uOpacity);
}
`;

  /** One oversized triangle, so there is no vertex buffer to manage. */
  const VERTEX = `#version 300 es
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -3.0), vec2(-1.0, 1.0), vec2(3.0, 1.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`;

  NS.SHADER = { vertex: VERTEX, fragment: FRAGMENT };
})(window.WinDuo);
