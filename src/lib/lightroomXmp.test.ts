import { describe, expect, it } from 'vitest'
import { createDefaultAdjustments } from './defaults'
import { parseLightroomXmp, serializeLightroomXmp } from './lightroomXmp'

const xmp = `
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Name="Soft &amp; Teal"
      crs:ProcessVersion="15.4"
      crs:Exposure2012="+0.45"
      crs:Contrast2012="12"
      crs:Highlights2012="-28"
      crs:IncrementalTemperature="18"
      crs:Tint="-6"
      crs:Vibrance="22"
      crs:HueAdjustmentBlue="-14"
      crs:SaturationAdjustmentBlue="-20"
      crs:ColorGradeShadowHue="205"
      crs:ColorGradeShadowSat="16"
      crs:ColorGradeBlending="62"
      crs:RedPrimaryHue="9"
      crs:Texture="15"
      crs:Clarity2012="22"
      crs:Dehaze="8"
      crs:SharpenAmount="40"
      crs:SharpenRadius="1.2"
      crs:SharpenDetail="30"
      crs:SharpenEdgeMasking="45"
      crs:LuminanceSmoothing="12"
      crs:ColorNoiseReduction="18"
      crs:PostCropVignetteAmount="-28"
      crs:PostCropVignetteMidpoint="42"
      crs:PostCropVignetteFeather="55"
      crs:CropTop="0.05">
      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 10</rdf:li>
          <rdf:li>64, 58</rdf:li>
          <rdf:li>128, 132</rdf:li>
          <rdf:li>255, 248</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`

describe('parseLightroomXmp', () => {
  it('maps Lightroom basic, HSL, curve, grading, calibration and detail values', () => {
    const preset = parseLightroomXmp(xmp, 'soft-teal.xmp')

    expect(preset.name).toBe('Soft & Teal')
    expect(preset.processVersion).toBe('15.4')
    expect(preset.adjustments.exposure).toBe(0.45)
    expect(preset.adjustments.highlights).toBe(-28)
    expect(preset.adjustments.temperature).toBe(18)
    expect(preset.adjustments.hsl.blue.hue).toBe(-14)
    expect(preset.adjustments.hsl.blue.saturation).toBe(-20)
    expect(preset.adjustments.colorGrading.shadows.hue).toBe(205)
    expect(preset.adjustments.colorGrading.blending).toBe(62)
    expect(preset.adjustments.calibration.redHue).toBe(9)
    expect(preset.adjustments.curves.master).toHaveLength(17)
    expect(preset.adjustments.curves.master[0]).toBeCloseTo(10 / 255)
    expect(preset.adjustments.skinProtect).toBe(0)
    expect(preset.adjustments.texture).toBe(15)
    expect(preset.adjustments.clarity).toBe(22)
    expect(preset.adjustments.dehaze).toBe(8)
    expect(preset.adjustments.sharpen).toBe(40)
    expect(preset.adjustments.sharpenRadius).toBeCloseTo(1.2)
    expect(preset.adjustments.sharpenDetail).toBe(30)
    expect(preset.adjustments.sharpenMasking).toBe(45)
    expect(preset.adjustments.luminanceNoiseReduction).toBe(12)
    expect(preset.adjustments.colorNoiseReduction).toBe(18)
    expect(preset.adjustments.vignette).toBe(-28)
    expect(preset.adjustments.vignetteMidpoint).toBe(42)
    expect(preset.adjustments.vignetteFeather).toBe(55)
    expect(preset.mappedFields).toContain('纹理')
    expect(preset.mappedFields).toContain('暗角')
    expect(preset.unsupportedFields).toContain('裁剪')
    expect(preset.unsupportedFields).not.toContain('纹理')
  })

  it('falls back to split toning and approximates absolute color temperature', () => {
    const preset = parseLightroomXmp(`
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="rdf"><rdf:Description xmlns:crs="camera-raw"
          crs:Temperature="6500" crs:SplitToningShadowHue="220"
          crs:SplitToningShadowSaturation="12" crs:SplitToningBalance="-20" />
        </rdf:RDF>
      </x:xmpmeta>
    `, 'winter.xmp')

    expect(preset.name).toBe('winter')
    expect(preset.adjustments.temperature).toBeGreaterThan(0)
    expect(preset.adjustments.colorGrading.shadows.hue).toBe(220)
    expect(preset.adjustments.colorGrading.balance).toBe(-20)
    expect(preset.warnings.join(' ')).toContain('5500K')
  })

  it('maps parametric curves and monochrome presets without AI skin protection', () => {
    const preset = parseLightroomXmp(`
      <x:xmpmeta xmlns:x='adobe:ns:meta/'>
        <rdf:RDF xmlns:rdf='rdf'><rdf:Description xmlns:crs='camera-raw'
          crs:ConvertToGrayscale='True' crs:ParametricShadows='-35'
          crs:ParametricDarks='-20' crs:ParametricLights='30'
          crs:ParametricHighlights='45' />
        </rdf:RDF>
      </x:xmpmeta>
    `, 'mono-curve.xmp')

    expect(preset.adjustments.saturation).toBe(-100)
    expect(preset.adjustments.skinProtect).toBe(0)
    expect(preset.adjustments.curves.master).toHaveLength(17)
    expect(preset.adjustments.curves.master[3]).toBeLessThan(3 / 16)
    expect(preset.adjustments.curves.master[13]).toBeGreaterThan(13 / 16)
    expect(preset.mappedFields).toContain('参数曲线')
  })

  it('rejects unrelated or geometry-only XMP files', () => {
    expect(() => parseLightroomXmp('<root/>')).toThrow('未识别')
    expect(() => parseLightroomXmp(`
      <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="rdf">
        <rdf:Description xmlns:crs="camera-raw" crs:CropTop="0.1" crs:PerspectiveVertical="5" />
      </rdf:RDF></x:xmpmeta>
    `)).toThrow('没有可映射')
  })

  it('serializes saved adjustments for a complete round trip', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.exposure = 0.65
    adjustments.temperature = 18
    adjustments.fade = 12
    adjustments.hsl.orange.saturation = -14
    adjustments.colorGrading.highlights.hue = 52
    adjustments.colorGrading.highlights.saturation = 20
    adjustments.calibration.blueHue = -8
    adjustments.curves.master = [0.04, 0.22, 0.51, 0.8, 0.96]

    const serialized = serializeLightroomXmp(adjustments, 'My / Preset')
    const preset = parseLightroomXmp(serialized, 'My _ Preset.xmp')

    expect(preset.name).toBe('My _ Preset')
    expect(preset.adjustments.exposure).toBe(0.65)
    expect(preset.adjustments.temperature).toBe(18)
    expect(preset.adjustments.fade).toBe(12)
    expect(preset.adjustments.hsl.orange.saturation).toBe(-14)
    expect(preset.adjustments.colorGrading.highlights.saturation).toBe(20)
    expect(preset.adjustments.calibration.blueHue).toBe(-8)
    expect(preset.adjustments.curves.master[0]).toBeCloseTo(10 / 255)
  })
})
