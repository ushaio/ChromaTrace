# AI Color Match Engine v0.4

Date: 2026-07-20

## Goal

Version 0.4 keeps the genuine cross-image color-style transfer introduced in v0.3 and adds a complete editable correction layer. Source and reference JPG images may have unrelated subjects, framing, lighting, dimensions, and pixel layouts. The engine does not inspect structural similarity and never fits corresponding source/reference pixels.

The pipeline is:

```text
source/reference image statistics
→ cross-image tone and OKLab tonal-zone transfer
→ constrained primary calibration
→ linear-light exposure / white balance and basic tonal controls
→ five-point master and RGB curves
→ eight-band HSL
→ OKLab three-way color grading
→ fade and deterministic grain
```

The advanced controls refine a statistical cross-image match. They are not a same-image reconstruction path and do not introduce pixel correspondence.

## 1. Cross-image baseline

Both images are sampled into a 256-bin OKLab lightness histogram. A monotonic percentile curve transfers a restrained part of the reference contrast and highlight/shadow distribution while remaining anchored to the source exposure.

Sampled pixels are also divided by lightness percentile into shadow, midtone, and highlight zones. Neutral-weighted OKLab statistics estimate transferable cast and chroma relationships while reducing leakage from scene-specific skies, foliage, clothing, and other saturated objects.

`matchStrength`, `preserveLuma`, and `skinProtect` limit the transfer. The baseline works without shared composition, shared objects, equal dimensions, or aligned pixels.

## 2. Stage 1: expanded basic controls

The editable basic correction layer now contains:

- exposure;
- contrast;
- highlights and shadows;
- whites and blacks;
- temperature and tint;
- vibrance and saturation;
- fade and grain.

Exposure and white-balance channel gains are applied in linear-light RGB. Tonal masks are computed from source-adapted luminance, and vibrance preferentially affects lower-saturation colors.

Local matching resets these correction controls to neutral so the baseline is not automatically graded twice. User-selected match strength, luminance preservation, and skin protection remain active.

## 3. Stage 2: editable five-point curves

Four curves are available:

- master lightness;
- red channel;
- green channel;
- blue channel.

Each curve stores five normalized output values at fixed input positions `[0, 0.25, 0.5, 0.75, 1]`. UI editing and renderer sanitization keep the outputs monotonic. Invalid arrays fall back to the identity curve `[0, 0.25, 0.5, 0.75, 1]`.

The master curve changes OKLab lightness before the per-channel RGB curves are evaluated. Curves are a secondary correction layer on top of the automatic percentile transfer.

## 4. Stage 3: eight-band HSL

Hue, saturation, and luminance can be edited independently for:

- red;
- orange;
- yellow;
- green;
- aqua;
- blue;
- purple;
- magenta.

Bands use overlapping cosine weights rather than hard hue boundaries. This avoids discontinuities near neighboring colors. Hue shifts, saturation changes, and luminance changes are bounded, blended, and reduced by skin protection where applicable.

## 5. Stage 4: three-way color grading

Shadows, midtones, and highlights each expose:

- hue;
- saturation;
- luminance.

`balance` moves the tonal emphasis and `blending` changes overlap between tonal zones. The renderer applies smooth Gaussian zone weights in OKLab lightness and adds restrained OKLab chroma vectors. This supports looks such as cool shadows with warm highlights without relying on scene correspondence.

## 6. Stage 5: constrained primary calibration

Red, green, and blue primaries each expose hue and saturation controls. Calibration is deliberately constrained and hue-weighted instead of using an unrestricted 3×3 matrix. This reduces gamut excursions and makes the control safer for unrelated source/reference scenes.

Skin protection also attenuates primary calibration on likely skin colors.

## 7. Visual-model protocol

The model prompt explicitly treats the two inputs as unrelated photographs and instructs the model to avoid pixel correspondence and absolute scene-color copying.

The structured response schema now includes:

- all expanded basic controls;
- four five-point curves;
- eight HSL channel objects;
- three color-grading zones plus balance and blending;
- constrained primary calibration;
- a concise Chinese style description.

Rust sanitization clamps every numeric range, replaces malformed curves with identity, forces curve monotonicity, normalizes grading hue, and supplies neutral defaults when older responses omit advanced fields.

## 8. UI behavior

The fine-tuning panel is ordered to match the rendering stages:

1. basic light controls;
2. basic color controls;
3. master/RGB curves;
4. eight-band HSL;
5. three-way color grading;
6. primary calibration;
7. finish controls.

The match panel continues to report percentile lightness transfer and OKLab three-zone color transfer. There is no same-image confidence score, paired mode, structural matching, or paired LUT path.

## Verification

Validation completed on 2026-07-20:

- `npx tsc -b`: passed;
- `npm test`: 20 tests passed across 2 files;
- `npm run build`: TypeScript and Vite production build passed;
- `cargo test`: 7 Rust tests passed;
- `cargo fmt -- --check`: passed after formatting.

Advanced regression tests cover:

- five-point identity and lifted curves;
- master and red-channel curve behavior;
- selective blue HSL behavior without equivalent orange movement;
- cool-shadow / warm-highlight color grading;
- constrained calibration remaining finite and in gamut;
- Rust defaults, curve repair, numeric clamping, grading hue normalization, HSL clamping, and calibration clamping.

## Known limitations

- Rendering remains an 8-bit Canvas path oriented to JPEG workflows.
- Five fixed curve points are less expressive than Lightroom's arbitrary-point and parametric curve tools.
- HSL bands are based on pixel hue, not semantic object classes.
- Neutral weighting cannot fully distinguish illumination, scene content, and an intentional grade.
- Skin protection is a soft color rule rather than a face/skin segmentation model.
- Texture, clarity, dehaze, sharpening, noise reduction, local masks, and full ICC color management are not implemented.
- Analysis and high-resolution rendering still run synchronously rather than in a Web Worker.

## Next iteration

1. Add non-paired quantitative style-distance diagnostics for tone, hue distribution, and tonal-zone chroma.
2. Add semantic masks for skin, sky, foliage, and neutral surfaces without using source/reference correspondence.
3. Upgrade the curve editor with optional additional points or a monotonic spline representation.
4. Move analysis and rendering into a Web Worker.
5. Add a curated cross-scene JPEG benchmark set for regression testing.
