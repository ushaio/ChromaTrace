import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_CONFIG, DEFAULT_MODEL_SETTINGS } from './defaults'
import { migrateLegacyModelConfig, normalizeModelSettings, resolveImageModel, resolveVisionModel } from './modelSettings'

describe('model settings', () => {
  it('migrates the legacy single-provider configuration without losing model fields', () => {
    const migrated = migrateLegacyModelConfig({
      ...DEFAULT_MODEL_CONFIG,
      enabled: true,
      providerName: 'Legacy Provider',
      baseUrl: 'https://legacy.example/v1',
      model: 'vision-old',
      imageModel: 'image-old',
      privacyAccepted: true,
      generationPrivacyAccepted: true,
    })

    expect(migrated.version).toBe(2)
    expect(migrated.providers[0]).toMatchObject({ id: 'provider-default', name: 'Legacy Provider' })
    expect(resolveVisionModel(migrated)).toMatchObject({ model: 'vision-old', baseUrl: 'https://legacy.example/v1', privacyAccepted: true })
    expect(resolveImageModel(migrated)).toMatchObject({ model: 'image-old', baseUrl: 'https://legacy.example/v1', privacyAccepted: true })
  })

  it('keeps vision and image models routed to independent providers', () => {
    const settings = normalizeModelSettings({
      ...DEFAULT_MODEL_SETTINGS,
      providers: [
        { id: 'provider-vision', name: 'Vision Cloud', baseUrl: 'https://vision.example/v1', apiType: 'responses' },
        { id: 'provider-image', name: 'Image Cloud', baseUrl: 'https://image.example/v1', apiType: 'chat-completions' },
      ],
      visionModels: [{ ...DEFAULT_MODEL_SETTINGS.visionModels[0], id: 'vision-a', providerId: 'provider-vision', model: 'vision-a' }],
      imageModels: [{ ...DEFAULT_MODEL_SETTINGS.imageModels[0], id: 'image-a', providerId: 'provider-image', model: 'image-a' }],
      activeVisionModelId: 'vision-a',
      activeImageModelId: 'image-a',
    })

    expect(resolveVisionModel(settings)).toMatchObject({ providerId: 'provider-vision', baseUrl: 'https://vision.example/v1' })
    expect(resolveImageModel(settings)).toMatchObject({ providerId: 'provider-image', baseUrl: 'https://image.example/v1' })
  })

  it('preserves /images/generations while dropping legacy per-model output parameters', () => {
    const settings = normalizeModelSettings({
      ...DEFAULT_MODEL_SETTINGS,
      providers: [{
        id: 'provider-image',
        name: 'Image Generator',
        baseUrl: 'https://image.example/v1',
        apiType: 'images-generations',
      }],
      imageModels: [{
        id: 'image-generation',
        providerId: 'provider-image',
        name: 'Generation Model',
        model: 'image-v1',
        quality: 'medium',
        size: 'auto',
        style: 'vivid',
        n: 3,
        responseFormat: 'url',
        timeoutSeconds: 180,
        maxImageSide: 2048,
        privacyAccepted: false,
      }],
      activeImageModelId: 'image-generation',
    })

    const image = resolveImageModel(settings)
    expect(settings.providers[0].apiType).toBe('images-generations')
    expect(image?.apiType).toBe('images-generations')
    expect(image).not.toHaveProperty('quality')
    expect(image).not.toHaveProperty('size')
    expect(image).not.toHaveProperty('style')
    expect(image).not.toHaveProperty('n')
    expect(image).not.toHaveProperty('responseFormat')
  })

})
