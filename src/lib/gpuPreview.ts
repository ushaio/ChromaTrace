import type { CubeLut3D } from './cubeLut'
import type { Adjustments, HslChannel, MatchProfile } from './types'

const HSL_CHANNELS: HslChannel[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
]

const GPU_CURVE_SAMPLES = 17
const IDENTITY_CURVE = Array.from({ length: GPU_CURVE_SAMPLES }, (_, index) => index / (GPU_CURVE_SAMPLES - 1))

const VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 position = gl_VertexID == 0
    ? vec2(-1.0, -1.0)
    : gl_VertexID == 1
      ? vec2(3.0, -1.0)
      : vec2(-1.0, 3.0);
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSource;
uniform sampler2D uToneCurve;
uniform sampler2D uToneCdf;
uniform vec4 uBasic0;
uniform vec4 uBasic1;
uniform vec4 uBasic2;
uniform vec4 uMatch;
uniform vec4 uDetail0;
uniform vec4 uDetail1;
uniform vec4 uDetail2;
uniform float uCurves[68];
uniform vec3 uHsl[8];
uniform vec3 uGrade[3];
uniform vec2 uGradeMeta;
uniform vec4 uCalibration0;
uniform vec2 uCalibration1;
uniform vec3 uSourceZones[3];
uniform vec3 uTargetZones[3];
uniform vec2 uResolution;
uniform int uHasProfile;
uniform int uStage;
uniform highp sampler3D uLut;
uniform int uHasLut;
uniform float uLutAmount;
uniform vec3 uLutDomainMin;
uniform vec3 uLutDomainMax;

const float PI = 3.14159265358979323846;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float saturate(float value) {
  return clamp(value, 0.0, 1.0);
}

vec3 saturate3(vec3 value) {
  return clamp(value, vec3(0.0), vec3(1.0));
}

float srgbToLinear(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow((value + 0.055) / 1.055, 2.4);
}

float linearToSrgb(float value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

float signedCbrt(float value) {
  return sign(value) * pow(abs(value), 1.0 / 3.0);
}

vec3 rgbToOklab(vec3 rgb) {
  vec3 linearRgb = vec3(
    srgbToLinear(rgb.r),
    srgbToLinear(rgb.g),
    srgbToLinear(rgb.b)
  );
  float l = signedCbrt(dot(linearRgb, vec3(0.4122214708, 0.5363325363, 0.0514459929)));
  float m = signedCbrt(dot(linearRgb, vec3(0.2119034982, 0.6806995451, 0.1073969566)));
  float s = signedCbrt(dot(linearRgb, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  );
}

vec3 oklabToRgb(vec3 lab) {
  float lRoot = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float mRoot = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float sRoot = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = lRoot * lRoot * lRoot;
  float m = mRoot * mRoot * mRoot;
  float s = sRoot * sRoot * sRoot;
  return vec3(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  );
}

float encodedLuma(vec3 rgb) {
  return dot(rgb, LUMA);
}

float skinMask(vec3 rgb) {
  float maximum = max(max(rgb.r, rgb.g), rgb.b);
  float minimum = min(min(rgb.r, rgb.g), rgb.b);
  float chroma = maximum - minimum;
  if (chroma < 0.04) return 0.0;

  float hue;
  if (maximum == rgb.r) hue = mod((rgb.g - rgb.b) / chroma, 6.0);
  else if (maximum == rgb.g) hue = (rgb.b - rgb.r) / chroma + 2.0;
  else hue = (rgb.r - rgb.g) / chroma + 4.0;
  hue = mod(hue * 60.0 + 360.0, 360.0);

  float saturation = chroma / max(0.001, maximum);
  float hueMask = hue <= 55.0 ? 1.0 - abs(hue - 27.0) / 28.0 : 0.0;
  return saturate(hueMask)
    * saturate((saturation - 0.08) / 0.35)
    * saturate((maximum - 0.15) / 0.5);
}

float protectedAmount(vec3 rgb, float maximumProtection) {
  return 1.0 - skinMask(rgb) * uMatch.w / 100.0 * maximumProtection;
}

float angularDistance(float left, float right) {
  return abs(mod(left - right + 180.0, 360.0) - 180.0);
}

float hueBandWeight(float hue, float center, float width) {
  float distance = angularDistance(hue, center);
  if (distance >= width) return 0.0;
  return (cos(PI * distance / width) + 1.0) * 0.5;
}

vec3 rgbToHsl(vec3 rgb) {
  float maximum = max(max(rgb.r, rgb.g), rgb.b);
  float minimum = min(min(rgb.r, rgb.g), rgb.b);
  float delta = maximum - minimum;
  float lightness = (maximum + minimum) * 0.5;
  if (delta < 0.000001) return vec3(0.0, 0.0, lightness);

  float saturation = delta / (1.0 - abs(2.0 * lightness - 1.0));
  float hue;
  if (maximum == rgb.r) hue = 60.0 * mod((rgb.g - rgb.b) / delta, 6.0);
  else if (maximum == rgb.g) hue = 60.0 * ((rgb.b - rgb.r) / delta + 2.0);
  else hue = 60.0 * ((rgb.r - rgb.g) / delta + 4.0);
  return vec3(mod(hue + 360.0, 360.0), saturate(saturation), saturate(lightness));
}

vec3 hslToRgb(vec3 hsl) {
  float hue = mod(hsl.x + 360.0, 360.0);
  float chroma = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float section = hue / 60.0;
  float x = chroma * (1.0 - abs(mod(section, 2.0) - 1.0));
  vec3 rgb;
  if (section < 1.0) rgb = vec3(chroma, x, 0.0);
  else if (section < 2.0) rgb = vec3(x, chroma, 0.0);
  else if (section < 3.0) rgb = vec3(0.0, chroma, x);
  else if (section < 4.0) rgb = vec3(0.0, x, chroma);
  else if (section < 5.0) rgb = vec3(x, 0.0, chroma);
  else rgb = vec3(chroma, 0.0, x);
  return saturate3(rgb + vec3(hsl.z - chroma * 0.5));
}

vec3 blendRgb(vec3 source, vec3 target, float amount) {
  return saturate3(mix(source, target, amount));
}

float sampleToneCurve(float lightness) {
  float position = saturate(lightness) * 255.0;
  int lower = int(floor(position));
  int upper = min(255, lower + 1);
  float fraction = position - float(lower);
  float lowerValue = texelFetch(uToneCurve, ivec2(lower, 0), 0).r;
  float upperValue = texelFetch(uToneCurve, ivec2(upper, 0), 0).r;
  return mix(lowerValue, upperValue, fraction);
}

float percentileAtTone(float lightness) {
  float position = saturate(lightness) * 256.0;
  int index = min(255, int(floor(position)));
  vec2 cdf = texelFetch(uToneCdf, ivec2(index, 0), 0).rg;
  return saturate(cdf.r + cdf.g * (position - float(index)));
}

vec3 applyCrossImageTransfer(vec3 rgb) {
  if (uHasProfile == 0) return rgb;

  vec3 lab = rgbToOklab(rgb);
  float percentile = percentileAtTone(lab.x);
  vec3 weights = vec3(
    max(0.0, 1.0 - abs(percentile - 1.0 / 6.0) / 0.5),
    max(0.0, 1.0 - abs(percentile - 0.5) / 0.5),
    max(0.0, 1.0 - abs(percentile - 5.0 / 6.0) / 0.5)
  );
  weights /= max(0.0001, weights.x + weights.y + weights.z);

  float targetA = 0.0;
  float targetB = 0.0;
  for (int zone = 0; zone < 3; zone += 1) {
    vec3 sourceZone = uSourceZones[zone];
    vec3 targetZone = uTargetZones[zone];
    float chromaScale = clamp(targetZone.z / max(0.012, sourceZone.z), 0.72, 1.38);
    targetA += ((lab.y - sourceZone.x) * chromaScale + targetZone.x) * weights[zone];
    targetB += ((lab.z - sourceZone.y) * chromaScale + targetZone.y) * weights[zone];
  }

  float mappedLightness = sampleToneCurve(lab.x);
  float targetLightness = mix(mappedLightness, lab.x, uMatch.z / 100.0);
  float protection = skinMask(rgb) * uMatch.w / 100.0;
  vec3 finalLab = vec3(
    mix(lab.x, targetLightness, uMatch.x / 100.0 * (1.0 - protection * 0.25)),
    mix(lab.y, targetA, uMatch.y / 100.0 * (1.0 - protection * 0.78)),
    mix(lab.z, targetB, uMatch.y / 100.0 * (1.0 - protection * 0.78))
  );
  return saturate3(oklabToRgb(finalLab));
}

vec3 applyCalibration(vec3 rgb) {
  vec3 hsl = rgbToHsl(rgb);
  vec3 primaryHue = vec3(uCalibration0.x, uCalibration0.z, uCalibration1.x);
  vec3 primarySaturation = vec3(uCalibration0.y, uCalibration0.w, uCalibration1.y);
  vec3 centers = vec3(0.0, 120.0, 240.0);
  float hueShift = 0.0;
  float saturationShift = 0.0;
  float totalWeight = 0.0;
  for (int primary = 0; primary < 3; primary += 1) {
    float weight = hueBandWeight(hsl.x, centers[primary], 105.0);
    hueShift += primaryHue[primary] / 100.0 * 25.0 * weight;
    saturationShift += primarySaturation[primary] / 100.0 * 0.48 * weight;
    totalWeight += weight;
  }
  float divisor = max(1.0, totalWeight);
  vec3 calibrated = hslToRgb(vec3(
    hsl.x + hueShift / divisor,
    saturate(hsl.y * (1.0 + saturationShift / divisor)),
    hsl.z
  ));
  return blendRgb(rgb, calibrated, protectedAmount(rgb, 0.7));
}

vec3 applyBasicAdjustments(vec3 rgb) {
  vec3 linearRgb = vec3(
    srgbToLinear(rgb.r),
    srgbToLinear(rgb.g),
    srgbToLinear(rgb.b)
  );
  linearRgb *= exp2(uBasic0.x);

  float temperature = uBasic1.z / 100.0;
  float tint = uBasic1.w / 100.0;
  linearRgb.r *= max(0.2, 1.0 + temperature * 0.18 + tint * 0.035);
  linearRgb.g *= max(0.2, 1.0 - tint * 0.11);
  linearRgb.b *= max(0.2, 1.0 - temperature * 0.18 + tint * 0.035);

  rgb = vec3(
    linearToSrgb(linearRgb.r),
    linearToSrgb(linearRgb.g),
    linearToSrgb(linearRgb.b)
  );

  float contrast = 1.0 + uBasic0.y / 100.0;
  rgb = (rgb - vec3(0.5)) * contrast + vec3(0.5);

  float luma = encodedLuma(rgb);
  float shadowMask = pow(1.0 - saturate(luma), 2.0);
  float highlightMask = pow(saturate(luma), 2.0);
  float lift = uBasic0.w / 100.0 * 0.32 * shadowMask
    + uBasic0.z / 100.0 * 0.28 * highlightMask
    + uBasic1.y / 100.0 * 0.16 * (1.0 - saturate(luma))
    + uBasic1.x / 100.0 * 0.16 * saturate(luma);
  rgb += vec3(lift);

  float adjustedLuma = encodedLuma(rgb);
  float currentSaturation = max(max(rgb.r, rgb.g), rgb.b) - min(min(rgb.r, rgb.g), rgb.b);
  float saturationFactor = 1.0 + uBasic2.y / 100.0
    + uBasic2.x / 100.0 * (1.0 - saturate(currentSaturation * 1.8));
  rgb = vec3(adjustedLuma) + (rgb - vec3(adjustedLuma)) * saturationFactor;

  float fade = uBasic2.z / 100.0;
  rgb = rgb * (1.0 - fade * 0.22) + vec3(fade * 0.12);
  return saturate3(rgb);
}

vec3 applyDehaze(vec3 rgb) {
  float amount = uDetail0.z / 100.0;
  if (abs(amount) < 0.0001) return rgb;
  float luma = encodedLuma(rgb);
  float pivot = 0.42;
  float contrast = 1.0 + amount * 0.48;
  rgb = (rgb - vec3(pivot)) * contrast + vec3(pivot - amount * 0.045);
  float satBoost = 1.0 + amount * 0.28 * (1.0 - saturate(abs(luma - 0.55) * 1.4));
  float mid = encodedLuma(rgb);
  return saturate3(vec3(mid) + (rgb - vec3(mid)) * satBoost);
}

float sampleCurve(float value, int offset) {
  float position = saturate(value) * 16.0;
  int lower = int(floor(position));
  int upper = min(16, lower + 1);
  float fraction = position - float(lower);
  return saturate(mix(uCurves[offset + lower], uCurves[offset + upper], fraction));
}

vec3 applyCurves(vec3 rgb) {
  vec3 master = vec3(
    sampleCurve(rgb.r, 0),
    sampleCurve(rgb.g, 0),
    sampleCurve(rgb.b, 0)
  );
  return vec3(
    sampleCurve(master.r, 17),
    sampleCurve(master.g, 34),
    sampleCurve(master.b, 51)
  );
}

vec3 applyHslAdjustments(vec3 rgb) {
  vec3 hsl = rgbToHsl(rgb);
  if (hsl.y < 0.0001) return rgb;

  const float centers[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 285.0, 330.0);
  const float widths[8] = float[8](42.0, 36.0, 44.0, 64.0, 54.0, 58.0, 44.0, 44.0);
  float hueShift = 0.0;
  float saturationShift = 0.0;
  float luminanceShift = 0.0;
  float totalWeight = 0.0;
  for (int band = 0; band < 8; band += 1) {
    float weight = hueBandWeight(hsl.x, centers[band], widths[band]);
    hueShift += uHsl[band].x / 100.0 * 30.0 * weight;
    saturationShift += uHsl[band].y / 100.0 * 0.65 * weight;
    luminanceShift += uHsl[band].z / 100.0 * 0.2 * weight;
    totalWeight += weight;
  }

  float divisor = max(1.0, totalWeight);
  vec3 target = hslToRgb(vec3(
    hsl.x + hueShift / divisor,
    saturate(hsl.y * (1.0 + saturationShift / divisor)),
    saturate(hsl.z + luminanceShift / divisor)
  ));
  return blendRgb(rgb, target, protectedAmount(rgb, 0.82));
}

vec3 applyColorGrading(vec3 rgb) {
  vec3 lab = rgbToOklab(rgb);
  float balance = uGradeMeta.x / 100.0 * 0.14;
  float width = 0.16 + uGradeMeta.y / 100.0 * 0.24;
  vec3 centers = vec3(0.22 + balance, 0.5 + balance * 0.35, 0.78 + balance);
  vec3 delta = (vec3(lab.x) - centers) / width;
  vec3 weights = exp(-0.5 * delta * delta);
  weights /= max(0.0001, weights.x + weights.y + weights.z);

  float lightnessShift = 0.0;
  float aShift = 0.0;
  float bShift = 0.0;
  for (int zone = 0; zone < 3; zone += 1) {
    float radians = uGrade[zone].x * PI / 180.0;
    float chroma = uGrade[zone].y / 100.0 * 0.075;
    aShift += cos(radians) * chroma * weights[zone];
    bShift += sin(radians) * chroma * weights[zone];
    lightnessShift += uGrade[zone].z / 100.0 * 0.1 * weights[zone];
  }

  vec3 target = oklabToRgb(vec3(
    saturate(lab.x + lightnessShift),
    lab.y + aShift,
    lab.z + bShift
  ));
  return blendRgb(rgb, target, protectedAmount(rgb, 0.82));
}

float pseudoRandom(float seed) {
  return fract(sin(seed * 12.9898 + 78.233) * 43758.5453);
}

vec3 sampleSourceRgb(vec2 uv) {
  vec2 sampleUv = uStage == 1 ? vec2(uv.x, 1.0 - uv.y) : uv;
  return texture(uSource, sampleUv).rgb;
}

vec3 blurSource(vec2 uv, float radiusPx) {
  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  vec3 center = sampleSourceRgb(uv);
  float centerLuma = encodedLuma(center);
  float rangeSigma = 0.07 + min(radiusPx, 3.0) * 0.025;
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  for (int oy = -2; oy <= 2; oy += 1) {
    for (int ox = -2; ox <= 2; ox += 1) {
      float sampleDist = length(vec2(float(ox), float(oy)));
      if (sampleDist > radiusPx + 0.01) continue;
      vec3 sampleRgb = sampleSourceRgb(uv + vec2(float(ox), float(oy)) * texel * max(radiusPx * 0.5, 1.0));
      float lumaDelta = encodedLuma(sampleRgb) - centerLuma;
      float rangeWeight = exp(-0.5 * lumaDelta * lumaDelta / (rangeSigma * rangeSigma));
      float w = rangeWeight / (1.0 + sampleDist);
      sum += sampleRgb * w;
      weight += w;
    }
  }
  return sum / max(weight, 0.0001);
}

vec3 applySpatialDetail(vec3 rgb, vec2 uv) {
  float textureAmount = uDetail0.x / 100.0;
  float clarityAmount = uDetail0.y / 100.0;
  float sharpenAmount = uDetail0.w / 100.0;
  float sharpenRadius = clamp(uDetail1.x, 0.5, 3.0);
  float sharpenDetail = uDetail1.y / 100.0;
  float sharpenMasking = uDetail1.z / 100.0;
  float lumaNr = uDetail1.w / 100.0;
  float colorNr = uDetail2.x / 100.0;

  vec3 center = sampleSourceRgb(uv);
  if (abs(textureAmount) > 0.0001 || abs(clarityAmount) > 0.0001) {
    vec3 fine = blurSource(uv, 1.0);
    vec3 broad = blurSource(uv, 2.4);
    vec3 fineDetail = center - fine;
    vec3 broadDetail = center - broad;
    float luma = encodedLuma(rgb);
    float midMask = 1.0 - saturate(abs(luma - 0.5) * 2.0);
    float highlightProtect = 1.0 - smoothstep(0.86, 1.0, encodedLuma(center)) * 0.75;
    rgb += (fineDetail * textureAmount * 0.85 + broadDetail * clarityAmount * 0.55 * midMask) * highlightProtect;
  }

  if (sharpenAmount > 0.0001) {
    vec3 blurred = blurSource(uv, sharpenRadius);
    vec3 detail = center - blurred;
    float edge = (abs(detail.r) + abs(detail.g) + abs(detail.b)) / 3.0;
    float mask = sharpenMasking <= 0.001
      ? 1.0
      : saturate((edge - sharpenMasking * 0.04) / max(0.02, sharpenMasking * 0.12 + 0.02));
    float amount = sharpenAmount * (0.55 + sharpenDetail * 0.75);
    rgb += detail * amount * mask;
  }

  if (lumaNr > 0.0001 || colorNr > 0.0001) {
    vec3 blurred = blurSource(uv, 1.0 + max(lumaNr, colorNr));
    float originalLuma = encodedLuma(rgb);
    float blurredLuma = encodedLuma(blurred);
    float mixedLuma = mix(originalLuma, blurredLuma, lumaNr * 0.85);
    vec3 chroma = rgb - vec3(originalLuma);
    vec3 blurredChroma = blurred - vec3(blurredLuma);
    rgb = vec3(mixedLuma) + mix(chroma, blurredChroma, colorNr);
  }

  return saturate3(rgb);
}

vec3 applyVignette(vec3 rgb, vec2 uv) {
  float amount = uDetail2.y / 100.0;
  if (abs(amount) < 0.0001) return rgb;
  vec2 centered = (uv - vec2(0.5)) * 2.0;
  float dist = length(centered);
  float inner = uDetail2.z / 100.0 * 0.95;
  float outer = inner + uDetail2.w / 100.0 * 1.15 + 0.08;
  float t = saturate((dist - inner) / max(0.001, outer - inner));
  // Avoid the GLSL reserved keyword "smooth".
  float falloff = t * t * (3.0 - 2.0 * t);
  return saturate3(rgb * (1.0 + amount * falloff * 0.85));
}

void main() {
  vec2 uv = vUv;
  vec4 source = vec4(sampleSourceRgb(uv), 1.0);
  vec3 rgb = source.rgb;

  if (uStage == 1) {
    rgb = applyCrossImageTransfer(rgb);
    rgb = applyCalibration(rgb);
    rgb = applyBasicAdjustments(rgb);
    rgb = applyDehaze(rgb);
    rgb = applyCurves(rgb);
    rgb = applyHslAdjustments(rgb);
    rgb = applyColorGrading(rgb);
    outColor = vec4(saturate3(rgb), source.a);
    return;
  }

  if (abs(uDetail0.x) + abs(uDetail0.y) + abs(uDetail0.w)
      + abs(uDetail1.w) + abs(uDetail2.x) > 0.0001) {
      rgb = applySpatialDetail(rgb, uv);
  }
  rgb = applyVignette(rgb, uv);

  // L2: 3D CUBE in sRGB-encoded domain after local grading (trilinear via sampler3D).
  if (uHasLut != 0 && uLutAmount > 0.0) {
    vec3 normalized = (rgb - uLutDomainMin) / max(uLutDomainMax - uLutDomainMin, vec3(1.0e-6));
    vec3 mapped = texture(uLut, saturate3(normalized)).rgb;
    rgb = mix(rgb, mapped, clamp(uLutAmount / 100.0, 0.0, 1.0));
  }

  float x = floor(gl_FragCoord.x - 0.5);
  float y = uResolution.y - 1.0 - floor(gl_FragCoord.y - 0.5);
  float pixelIndex = y * uResolution.x + x;
  float grainAmount = uBasic2.w / 100.0 * 13.0 / 255.0;
  float noise = grainAmount == 0.0 ? 0.0 : (pseudoRandom(pixelIndex) - 0.5) * grainAmount;
  outColor = vec4(saturate3(rgb + vec3(noise)), source.a);
}
`

export interface PackedGpuAdjustments {
  basic0: Float32Array
  basic1: Float32Array
  basic2: Float32Array
  match: Float32Array
  detail0: Float32Array
  detail1: Float32Array
  detail2: Float32Array
  curves: Float32Array
  hsl: Float32Array
  grade: Float32Array
  gradeMeta: Float32Array
  calibration0: Float32Array
  calibration1: Float32Array
}

function normalizeCurve(points: number[]) {
  if (points.length < 2 || points.some((value) => !Number.isFinite(value))) {
    return [...IDENTITY_CURVE]
  }
  const normalized = points.map((value) => Math.min(1, Math.max(0, value)))
  for (let index = 1; index < normalized.length; index += 1) {
    normalized[index] = Math.max(normalized[index - 1], normalized[index])
  }
  return IDENTITY_CURVE.map((_, index) => {
    const position = index / (GPU_CURVE_SAMPLES - 1) * (normalized.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(normalized.length - 1, lower + 1)
    return normalized[lower] + (normalized[upper] - normalized[lower]) * (position - lower)
  })
}

export function packGpuAdjustments(adjustments: Adjustments): PackedGpuAdjustments {
  const curves = [
    ...normalizeCurve(adjustments.curves.master),
    ...normalizeCurve(adjustments.curves.red),
    ...normalizeCurve(adjustments.curves.green),
    ...normalizeCurve(adjustments.curves.blue),
  ]
  const hsl = HSL_CHANNELS.flatMap((channel) => {
    const value = adjustments.hsl[channel]
    return [value.hue, value.saturation, value.luminance]
  })
  const grade = [
    adjustments.colorGrading.shadows,
    adjustments.colorGrading.midtones,
    adjustments.colorGrading.highlights,
  ].flatMap((zone) => [zone.hue, zone.saturation, zone.luminance])

  return {
    basic0: new Float32Array([
      adjustments.exposure,
      adjustments.contrast,
      adjustments.highlights,
      adjustments.shadows,
    ]),
    basic1: new Float32Array([
      adjustments.whites,
      adjustments.blacks,
      adjustments.temperature,
      adjustments.tint,
    ]),
    basic2: new Float32Array([
      adjustments.vibrance,
      adjustments.saturation,
      adjustments.fade,
      adjustments.grain,
    ]),
    match: new Float32Array([
      adjustments.toneMatchStrength,
      adjustments.colorMatchStrength,
      adjustments.preserveLuma,
      adjustments.skinProtect,
    ]),
    detail0: new Float32Array([
      adjustments.texture,
      adjustments.clarity,
      adjustments.dehaze,
      adjustments.sharpen,
    ]),
    detail1: new Float32Array([
      adjustments.sharpenRadius,
      adjustments.sharpenDetail,
      adjustments.sharpenMasking,
      adjustments.luminanceNoiseReduction,
    ]),
    detail2: new Float32Array([
      adjustments.colorNoiseReduction,
      adjustments.vignette,
      adjustments.vignetteMidpoint,
      adjustments.vignetteFeather,
    ]),
    curves: new Float32Array(curves),
    hsl: new Float32Array(hsl),
    grade: new Float32Array(grade),
    gradeMeta: new Float32Array([
      adjustments.colorGrading.balance,
      adjustments.colorGrading.blending,
    ]),
    calibration0: new Float32Array([
      adjustments.calibration.redHue,
      adjustments.calibration.redSaturation,
      adjustments.calibration.greenHue,
      adjustments.calibration.greenSaturation,
    ]),
    calibration1: new Float32Array([
      adjustments.calibration.blueHue,
      adjustments.calibration.blueSaturation,
    ]),
  }
}

export function buildToneCdfTexture(histogram: number[]) {
  const data = new Float32Array(256 * 2)
  let prefix = 0
  for (let index = 0; index < 256; index += 1) {
    const probability = Number.isFinite(histogram[index]) ? Math.max(0, histogram[index]) : 0
    data[index * 2] = prefix
    data[index * 2 + 1] = probability
    prefix += probability
  }
  return data
}

function packToneCurve(profile: MatchProfile) {
  const packed = new Float32Array(256)
  const curve = profile.transfer.toneCurve
  if (curve.length === 0) return packed
  for (let index = 0; index < packed.length; index += 1) {
    const sourceIndex = Math.min(curve.length - 1, index)
    packed[index] = curve[sourceIndex]
  }
  return packed
}

function packZones(profile: MatchProfile) {
  const source = new Float32Array(9)
  const target = new Float32Array(9)
  for (let index = 0; index < 3; index += 1) {
    const sourceZone = profile.transfer.sourceZones[index]
    const targetZone = profile.transfer.zones[index]
    source.set([sourceZone.meanA, sourceZone.meanB, sourceZone.chroma], index * 3)
    target.set([targetZone.meanA, targetZone.meanB, targetZone.chroma], index * 3)
  }
  return { source, target }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error'
    gl.deleteShader(shader)
    throw new Error(log)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!program) throw new Error('Unable to create WebGL program')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'Unknown WebGL link error'
    gl.deleteProgram(program)
    throw new Error(log)
  }
  return program
}

function createTexture(gl: WebGL2RenderingContext, textureUnit: number) {
  const texture = gl.createTexture()
  if (!texture) throw new Error('Unable to create WebGL texture')
  gl.activeTexture(gl.TEXTURE0 + textureUnit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

export class GpuPreviewRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly renderCanvas: HTMLCanvasElement
  private readonly outputContext: CanvasRenderingContext2D
  private readonly program: WebGLProgram
  private readonly sourceTexture: WebGLTexture
  private readonly gradedTexture: WebGLTexture
  private readonly gradedFramebuffer: WebGLFramebuffer
  private readonly toneCurveTexture: WebGLTexture
  private readonly toneCdfTexture: WebGLTexture
  private readonly lutTexture: WebGLTexture
  private readonly uniforms: Record<string, WebGLUniformLocation>
  private readonly vertexArray: WebGLVertexArrayObject
  private profile: MatchProfile | null | undefined
  private cubeLut: CubeLut3D | null = null
  private width = 0
  private height = 0
  private validated = false
  private disposed = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Keep WebGL off-DOM and present its completed frame through a regular 2D
    // canvas. WebView2 can black out a directly composited WebGL canvas even
    // when the framebuffer is valid; the offscreen presentation path avoids
    // that compositor bug without falling back to CPU color processing.
    this.renderCanvas = document.createElement('canvas')
    const outputContext = canvas.getContext('2d', { alpha: false })
    if (!outputContext) throw new Error('Unable to create preview presentation context')
    this.outputContext = outputContext

    const gl = this.renderCanvas.getContext('webgl2', {
      // The preview is always an opaque photograph. An opaque default
      // framebuffer avoids WebView2's transparent DirectComposition path,
      // which can present an otherwise valid WebGL frame as black.
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      stencil: false,
    })
    if (!gl) throw new Error('WebGL2 is unavailable')

    this.gl = gl
    this.program = createProgram(gl)
    this.sourceTexture = createTexture(gl, 0)
    this.gradedTexture = createTexture(gl, 4)
    const gradedFramebuffer = gl.createFramebuffer()
    if (!gradedFramebuffer) throw new Error('Unable to create graded preview framebuffer')
    this.gradedFramebuffer = gradedFramebuffer
    this.toneCurveTexture = createTexture(gl, 1)
    this.toneCdfTexture = createTexture(gl, 2)
    const lutTexture = gl.createTexture()
    if (!lutTexture) throw new Error('Unable to create 3D LUT texture')
    this.lutTexture = lutTexture
    const vertexArray = gl.createVertexArray()
    if (!vertexArray) throw new Error('Unable to create WebGL vertex array')
    this.vertexArray = vertexArray
    this.uniforms = {}

    const uniformNames = [
      'uSource', 'uToneCurve', 'uToneCdf', 'uBasic0', 'uBasic1', 'uBasic2', 'uMatch',
      'uDetail0', 'uDetail1', 'uDetail2',
      'uCurves[0]', 'uHsl[0]', 'uGrade[0]', 'uGradeMeta', 'uCalibration0', 'uCalibration1',
      'uSourceZones[0]', 'uTargetZones[0]', 'uResolution', 'uHasProfile',
      'uStage',
      'uLut', 'uHasLut', 'uLutAmount', 'uLutDomainMin', 'uLutDomainMax',
    ]
    for (const name of uniformNames) {
      const location = gl.getUniformLocation(this.program, name)
      if (location === null) throw new Error(`Missing WebGL uniform: ${name}`)
      this.uniforms[name] = location
    }

    gl.useProgram(this.program)
    gl.uniform1i(this.uniforms.uSource, 0)
    gl.uniform1i(this.uniforms.uStage, 1)
    gl.uniform1i(this.uniforms.uToneCurve, 1)
    gl.uniform1i(this.uniforms.uToneCdf, 2)
    gl.uniform1i(this.uniforms.uLut, 3)
    gl.uniform1i(this.uniforms.uHasLut, 0)
    gl.uniform1f(this.uniforms.uLutAmount, 0)
    gl.uniform3f(this.uniforms.uLutDomainMin, 0, 0, 0)
    gl.uniform3f(this.uniforms.uLutDomainMax, 1, 1, 1)

    // Identity 2³ LUT as RGBA8. Float 3D textures + LINEAR often sample black in
    // WebView2 (no OES_texture_float_linear for 3D); 8-bit is universally filterable.
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    const identity = new Uint8Array(2 * 2 * 2 * 4)
    let cursor = 0
    for (let b = 0; b < 2; b += 1) {
      for (let g = 0; g < 2; g += 1) {
        for (let r = 0; r < 2; r += 1) {
          identity[cursor++] = r * 255
          identity[cursor++] = g * 255
          identity[cursor++] = b * 255
          identity[cursor++] = 255
        }
      }
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, identity)

    const identityToneCurve = new Float32Array(256)
    for (let index = 0; index < identityToneCurve.length; index += 1) {
      identityToneCurve[index] = index / 255
    }
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.toneCurveTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, identityToneCurve)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.toneCdfTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 256, 1, 0, gl.RG, gl.FLOAT, new Float32Array(512))

    gl.bindVertexArray(this.vertexArray)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.disable(gl.CULL_FACE)
    gl.colorMask(true, true, true, true)
  }

  getMaxTextureSize() {
    if (this.disposed) return 4096
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number
  }

  setSource(source: ImageData) {
    if (this.disposed) throw new Error('WebGL preview renderer was disposed')
    const { gl } = this
    if (gl.isContextLost()) throw new Error('WebGL preview context was lost')
    this.bindSourceSize(source.width, source.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    // ImageData exposes Uint8ClampedArray. Chromium accepts it, but some
    // WebView2 versions are more reliable with the exact WebGL upload view.
    const pixels = new Uint8Array(
      source.data.buffer,
      source.data.byteOffset,
      source.data.byteLength,
    )
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      source.width,
      source.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    )
    this.validated = false
  }

  /**
   * Upload a full-resolution HTML image/canvas directly (no getImageData).
   * Much faster for export than decoding through ImageData first.
   */
  setSourceFromBitmap(source: HTMLImageElement | HTMLCanvasElement | ImageBitmap, width: number, height: number) {
    if (this.disposed) throw new Error('WebGL preview renderer was disposed')
    const { gl } = this
    if (gl.isContextLost()) throw new Error('WebGL preview context was lost')
    this.bindSourceSize(width, height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) throw new Error(`WebGL source upload failed with error ${error}`)
    this.validated = false
  }

  private bindSourceSize(width: number, height: number) {
    const { gl } = this
    this.width = width
    this.height = height
    this.renderCanvas.width = width
    this.renderCanvas.height = height
    this.canvas.width = width
    this.canvas.height = height
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.gradedTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gradedFramebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.gradedTexture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      throw new Error('Unable to allocate graded preview framebuffer')
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
  }

  /** Force a complete GPU frame and return the presentation canvas (export path). */
  renderForExport(adjustments: Adjustments, profile?: MatchProfile | null) {
    this.render(adjustments, profile)
    this.gl.finish()
    const error = this.gl.getError()
    if (error !== this.gl.NO_ERROR) throw new Error(`WebGL export draw failed with error ${error}`)
    return this.canvas
  }

  setCubeLut(lut: CubeLut3D | null) {
    if (this.disposed) throw new Error('WebGL preview renderer was disposed')
    const { gl } = this
    if (gl.isContextLost()) throw new Error('WebGL preview context was lost')
    this.cubeLut = lut
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture)
    if (!lut) {
      gl.uniform1i(this.uniforms.uHasLut, 0)
      gl.uniform1f(this.uniforms.uLutAmount, 0)
      return
    }
    // Cube lattice: R fastest, then G, then B (WebGL width=R, height=G, depth=B).
    // Quantize to 8-bit for reliable LINEAR sampling in WebView2; export still uses float CPU.
    const count = lut.size * lut.size * lut.size
    const rgba = new Uint8Array(count * 4)
    for (let index = 0, out = 0; index < lut.data.length; index += 3, out += 4) {
      rgba[out] = Math.max(0, Math.min(255, Math.round(lut.data[index] * 255)))
      rgba[out + 1] = Math.max(0, Math.min(255, Math.round(lut.data[index + 1] * 255)))
      rgba[out + 2] = Math.max(0, Math.min(255, Math.round(lut.data[index + 2] * 255)))
      rgba[out + 3] = 255
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      lut.size,
      lut.size,
      lut.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    )
    const error = gl.getError()
    if (error !== gl.NO_ERROR) {
      // Leave LUT disabled on GPU rather than sampling an invalid texture (black frame).
      this.cubeLut = null
      gl.uniform1i(this.uniforms.uHasLut, 0)
      throw new Error(`WebGL 3D LUT upload failed with error ${error}`)
    }
    gl.uniform1i(this.uniforms.uHasLut, 1)
    gl.uniform3f(this.uniforms.uLutDomainMin, lut.domainMin[0], lut.domainMin[1], lut.domainMin[2])
    gl.uniform3f(this.uniforms.uLutDomainMax, lut.domainMax[0], lut.domainMax[1], lut.domainMax[2])
  }

  render(adjustments: Adjustments, profile?: MatchProfile | null) {
    if (!this.width || !this.height) return
    if (this.disposed) throw new Error('WebGL preview renderer was disposed')
    const { gl } = this
    if (gl.isContextLost()) throw new Error('WebGL preview context was lost')
    const packed = packGpuAdjustments(adjustments)

    gl.viewport(0, 0, this.width, this.height)
    gl.bindVertexArray(this.vertexArray)
    gl.useProgram(this.program)
    gl.uniform4fv(this.uniforms.uBasic0, packed.basic0)
    gl.uniform4fv(this.uniforms.uBasic1, packed.basic1)
    gl.uniform4fv(this.uniforms.uBasic2, packed.basic2)
    gl.uniform4fv(this.uniforms.uMatch, packed.match)
    gl.uniform4fv(this.uniforms.uDetail0, packed.detail0)
    gl.uniform4fv(this.uniforms.uDetail1, packed.detail1)
    gl.uniform4fv(this.uniforms.uDetail2, packed.detail2)
    gl.uniform1fv(this.uniforms['uCurves[0]'], packed.curves)
    gl.uniform3fv(this.uniforms['uHsl[0]'], packed.hsl)
    gl.uniform3fv(this.uniforms['uGrade[0]'], packed.grade)
    gl.uniform2fv(this.uniforms.uGradeMeta, packed.gradeMeta)
    gl.uniform4fv(this.uniforms.uCalibration0, packed.calibration0)
    gl.uniform2fv(this.uniforms.uCalibration1, packed.calibration1)
    gl.uniform2f(this.uniforms.uResolution, this.width, this.height)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture)
    gl.uniform1i(this.uniforms.uHasLut, this.cubeLut ? 1 : 0)
    gl.uniform1f(this.uniforms.uLutAmount, this.cubeLut ? adjustments.lutAmount : 0)
    if (this.cubeLut) {
      gl.uniform3f(this.uniforms.uLutDomainMin, this.cubeLut.domainMin[0], this.cubeLut.domainMin[1], this.cubeLut.domainMin[2])
      gl.uniform3f(this.uniforms.uLutDomainMax, this.cubeLut.domainMax[0], this.cubeLut.domainMax[1], this.cubeLut.domainMax[2])
    }

    if (profile !== this.profile) {
      this.uploadProfile(profile || null)
      this.profile = profile
    }
    gl.uniform1i(this.uniforms.uHasProfile, profile ? 1 : 0)
    // Pass 1 writes the complete color grade into an intermediate texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gradedFramebuffer)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture)
    gl.uniform1i(this.uniforms.uSource, 0)
    gl.uniform1i(this.uniforms.uStage, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Pass 2 samples only graded neighbors for detail and noise reduction.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.gradedTexture)
    gl.uniform1i(this.uniforms.uSource, 4)
    gl.uniform1i(this.uniforms.uStage, 2)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (!this.validated) {
      // Synchronize only the first frame after a source upload. Slider frames
      // stay fully asynchronous and continue to update once per display frame.
      gl.finish()
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw new Error(`WebGL preview draw failed with error ${error}`)
      this.validated = true
    } else {
      gl.flush()
    }
    this.outputContext.globalCompositeOperation = 'copy'
    this.outputContext.drawImage(this.renderCanvas, 0, 0)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const { gl } = this
    gl.deleteTexture(this.sourceTexture)
    gl.deleteTexture(this.gradedTexture)
    gl.deleteFramebuffer(this.gradedFramebuffer)
    gl.deleteTexture(this.toneCurveTexture)
    gl.deleteTexture(this.toneCdfTexture)
    gl.deleteTexture(this.lutTexture)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteProgram(this.program)
  }

  private uploadProfile(profile: MatchProfile | null) {
    if (!profile) return
    const { gl } = this
    const zones = packZones(profile)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.toneCurveTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, packToneCurve(profile))

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.toneCdfTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32F,
      256,
      1,
      0,
      gl.RG,
      gl.FLOAT,
      buildToneCdfTexture(profile.source.toneHistogram),
    )

    gl.uniform3fv(this.uniforms['uSourceZones[0]'], zones.source)
    gl.uniform3fv(this.uniforms['uTargetZones[0]'], zones.target)
  }
}
