import { describe, expect, it } from 'vitest'
import { parseLightroomXmp } from './lightroomXmp'

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
      crs:Texture="15">
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
  it('maps Lightroom basic, HSL, curve, grading and calibration values', () => {
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
    expect(preset.adjustments.curves.master).toHaveLength(5)
    expect(preset.adjustments.curves.master[0]).toBeCloseTo(10 / 255)
    expect(preset.unsupportedFields).toContain('纹理')
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

  it('rejects unrelated or unsupported-only XMP files', () => {
    expect(() => parseLightroomXmp('<root/>')).toThrow('未识别')
    expect(() => parseLightroomXmp(`
      <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="rdf">
        <rdf:Description xmlns:crs="camera-raw" crs:Texture="20" />
      </rdf:RDF></x:xmpmeta>
    `)).toThrow('没有可映射')
  })
})
