import {
  Boxes, Check, CloudCog, Eye, Image, KeyRound, LoaderCircle, LockKeyhole, Plus,
  Save, Server, Trash2, WandSparkles, Wifi, WifiOff, X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  persistModelSettings, removeProviderApiKey, saveProviderApiKey, testModelConnection,
} from '../lib/desktop'
import { createImageModel, createProvider, createVisionModel, resolveImageModel, resolveVisionModel } from '../lib/modelSettings'
import type {
  ImageGenerationModelConfig, ModelProvider, ModelSettings, VisionModelConfig,
} from '../lib/types'

type ModelSettingsTab = 'providers' | 'vision' | 'image'

type Notify = (message: string, kind?: 'ok' | 'error') => void

interface ModelSettingsWorkspaceProps {
  settings: ModelSettings
  credentialStatus: Record<string, boolean>
  settingsLoaded: boolean
  onChange: (settings: ModelSettings) => void
  onCredentialStatusChange: (providerId: string, present: boolean) => void
  notify: Notify
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
}

export function ModelSettingsWorkspace({
  settings, credentialStatus, settingsLoaded, onChange, onCredentialStatusChange, notify,
}: ModelSettingsWorkspaceProps) {
  const [tab, setTab] = useState<ModelSettingsTab>('providers')
  const [selectedProviderId, setSelectedProviderId] = useState(settings.providers[0]?.id || '')
  const [selectedVisionId, setSelectedVisionId] = useState(settings.activeVisionModelId || settings.visionModels[0]?.id || '')
  const [selectedImageId, setSelectedImageId] = useState(settings.activeImageModelId || settings.imageModels[0]?.id || '')
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [busyAction, setBusyAction] = useState('')

  const activeVision = useMemo(() => resolveVisionModel(settings), [settings])
  const activeImage = useMemo(() => resolveImageModel(settings), [settings])
  const selectedProvider = settings.providers.find((provider) => provider.id === selectedProviderId) || settings.providers[0] || null
  const selectedVision = settings.visionModels.find((model) => model.id === selectedVisionId) || settings.visionModels[0] || null
  const selectedImage = settings.imageModels.find((model) => model.id === selectedImageId) || settings.imageModels[0] || null
  const selectedImageProvider = selectedImage
    ? settings.providers.find((provider) => provider.id === selectedImage.providerId) || null
    : null
  const selectedImageUsesGenerations = selectedImageProvider?.apiType === 'images-generations'

  useEffect(() => {
    if (!settings.providers.some((provider) => provider.id === selectedProviderId)) setSelectedProviderId(settings.providers[0]?.id || '')
    if (!settings.visionModels.some((model) => model.id === selectedVisionId)) setSelectedVisionId(settings.activeVisionModelId || settings.visionModels[0]?.id || '')
    if (!settings.imageModels.some((model) => model.id === selectedImageId)) setSelectedImageId(settings.activeImageModelId || settings.imageModels[0]?.id || '')
  }, [selectedImageId, selectedProviderId, selectedVisionId, settings])

  const updateProvider = <K extends keyof ModelProvider>(providerId: string, key: K, value: ModelProvider[K]) => {
    const current = settings.providers.find((provider) => provider.id === providerId)
    const endpointChanged = (key === 'baseUrl' || key === 'apiType') && current?.[key] !== value
    onChange({
      ...settings,
      providers: settings.providers.map((provider) => provider.id === providerId ? { ...provider, [key]: value } : provider),
      visionModels: endpointChanged
        ? settings.visionModels.map((model) => model.providerId === providerId ? { ...model, privacyAccepted: false } : model)
        : settings.visionModels,
      imageModels: endpointChanged
        ? settings.imageModels.map((model) => model.providerId === providerId
            ? { ...model, privacyAccepted: false }
            : model)
        : settings.imageModels,
    })
  }

  const updateVision = <K extends keyof VisionModelConfig>(modelId: string, key: K, value: VisionModelConfig[K]) => {
    onChange({
      ...settings,
      visionModels: settings.visionModels.map((model) => model.id === modelId
        ? { ...model, [key]: value, ...(key === 'providerId' ? { privacyAccepted: false } : {}) }
        : model),
    })
  }

  const updateImage = <K extends keyof ImageGenerationModelConfig>(modelId: string, key: K, value: ImageGenerationModelConfig[K]) => {
    onChange({
      ...settings,
      imageModels: settings.imageModels.map((model) => model.id === modelId
        ? { ...model, [key]: value, ...(key === 'providerId' ? { privacyAccepted: false } : {}) }
        : model),
    })
  }

  const changeImageProvider = (model: ImageGenerationModelConfig, providerId: string) => {
    onChange({
      ...settings,
      imageModels: settings.imageModels.map((item) => item.id === model.id
        ? { ...item, providerId, privacyAccepted: false }
        : item),
    })
  }

  const validateSettings = () => {
    if (!settings.providers.length) throw new Error('请至少保留一个模型供应商')
    const invalidProvider = settings.providers.find((provider) => !provider.name.trim() || !provider.baseUrl.trim())
    if (invalidProvider) throw new Error(`请完善供应商“${invalidProvider.name || '未命名供应商'}”的名称和 Base URL`)
    if (settings.enabled && (!activeVision || !activeVision.model.trim())) throw new Error('启用模型能力前，请选择并配置当前视觉模型')
  }

  const saveAll = async (showSuccess = true) => {
    validateSettings()
    for (const provider of settings.providers) {
      const key = apiKeyInputs[provider.id]?.trim()
      if (!key) continue
      await saveProviderApiKey(provider.id, key)
      onCredentialStatusChange(provider.id, true)
    }
    setApiKeyInputs({})
    await persistModelSettings(settings)
    if (showSuccess) notify('模型供应商与模型配置已保存')
  }

  const testProvider = async (provider: ModelProvider) => {
    setBusyAction(`test:${provider.id}`)
    try {
      const key = apiKeyInputs[provider.id]?.trim()
      if (key) {
        await saveProviderApiKey(provider.id, key)
        onCredentialStatusChange(provider.id, true)
        setApiKeyInputs((current) => ({ ...current, [provider.id]: '' }))
      }
      if (!credentialStatus[provider.id] && !key) throw new Error('请先保存该供应商的 API Key')
      await persistModelSettings(settings)
      notify(await testModelConnection(provider))
    } catch (error) {
      notify(errorMessage(error, '连接测试失败'), 'error')
    } finally {
      setBusyAction('')
    }
  }

  const clearCredential = async (providerId: string) => {
    setBusyAction(`clear:${providerId}`)
    try {
      await removeProviderApiKey(providerId)
      onCredentialStatusChange(providerId, false)
      setApiKeyInputs((current) => ({ ...current, [providerId]: '' }))
      notify('该供应商的 API Key 已从 Windows 凭据管理器删除')
    } catch (error) {
      notify(errorMessage(error, '删除凭据失败'), 'error')
    } finally {
      setBusyAction('')
    }
  }

  const addProvider = () => {
    const provider = createProvider(settings.providers.length + 1)
    onChange({ ...settings, providers: [...settings.providers, provider] })
    setSelectedProviderId(provider.id)
    setTab('providers')
  }

  const deleteProvider = (provider: ModelProvider) => {
    const referenced = settings.visionModels.some((model) => model.providerId === provider.id)
      || settings.imageModels.some((model) => model.providerId === provider.id)
    if (referenced) return notify('该供应商仍被视觉模型或图像模型引用，请先调整或删除关联模型', 'error')
    if (settings.providers.length === 1) return notify('请至少保留一个模型供应商', 'error')
    if (!window.confirm(`确定删除供应商“${provider.name}”吗？其凭据不会自动删除。`)) return
    onChange({ ...settings, providers: settings.providers.filter((item) => item.id !== provider.id) })
  }

  const addVision = () => {
    if (!settings.providers.length) return notify('请先添加模型供应商', 'error')
    const model = createVisionModel(selectedProvider?.id || settings.providers[0].id, settings.visionModels.length + 1)
    onChange({
      ...settings,
      visionModels: [...settings.visionModels, model],
      activeVisionModelId: settings.activeVisionModelId || model.id,
    })
    setSelectedVisionId(model.id)
    setTab('vision')
  }

  const deleteVision = (model: VisionModelConfig) => {
    const models = settings.visionModels.filter((item) => item.id !== model.id)
    onChange({
      ...settings,
      visionModels: models,
      activeVisionModelId: settings.activeVisionModelId === model.id ? models[0]?.id || '' : settings.activeVisionModelId,
    })
  }

  const addImage = () => {
    if (!settings.providers.length) return notify('请先添加模型供应商', 'error')
    const provider = selectedProvider || settings.providers[0]
    const model = createImageModel(provider.id, settings.imageModels.length + 1)
    onChange({
      ...settings,
      imageModels: [...settings.imageModels, model],
      activeImageModelId: settings.activeImageModelId || model.id,
    })
    setSelectedImageId(model.id)
    setTab('image')
  }

  const deleteImage = (model: ImageGenerationModelConfig) => {
    const models = settings.imageModels.filter((item) => item.id !== model.id)
    onChange({
      ...settings,
      imageModels: models,
      activeImageModelId: settings.activeImageModelId === model.id ? models[0]?.id || '' : settings.activeImageModelId,
    })
  }

  const sectionMeta = tab === 'providers'
    ? { eyebrow: 'PROVIDER REGISTRY', title: '模型供应商', description: '独立维护服务地址、API 类型与安全凭据。视觉和图像模型可引用不同供应商。' }
    : tab === 'vision'
      ? { eyebrow: 'VISION MODELS', title: '视觉模型', description: '用于 AI 追色、图片理解、提示词优化和结构化调色配方。' }
      : { eyebrow: 'IMAGE GENERATION', title: '图像生成模型', description: '用于图像编辑或 /images/generations 纯文本生图，与视觉分析模型完全独立。' }

  return (
    <section className="model-settings-workspace settings-module">
      <header className="model-settings-hero">
        <div>
          <span className="settings-breadcrumb">设置 <i>/</i> 模型设置</span>
          <span className="kicker">MODEL ORCHESTRATION / WINDOWS</span>
          <h2>模型设置</h2>
          <p>集中维护多个模型供应商，并为视觉分析与图像生成分别选择当前模型。</p>
        </div>
        <div className={`model-overview ${settings.enabled ? 'is-enabled' : ''}`}>
          <span className="model-overview__icon">{settings.enabled ? <Wifi size={22}/> : <WifiOff size={22}/>}</span>
          <div><span>当前路由</span><strong>{settings.enabled ? '模型能力已启用' : '完全离线模式'}</strong><small>{activeVision?.name || '未选择视觉模型'} · {activeImage?.name || '未选择图像模型'}</small></div>
        </div>
      </header>

      <div className="model-settings-scroll model-registry-scroll">
        <section className="module model-capability-banner">
          <div className="model-capability-banner__copy">
            <span className="model-capability-banner__icon"><CloudCog size={19}/></span>
            <div><strong>模型能力总开关</strong><small>关闭后所有 AI 工作流停用，但供应商与模型配置会继续保留。</small></div>
          </div>
          <label className="toggle-row toggle-row--compact">
            <span><b>{settings.enabled ? '已启用' : '已关闭'}</b></span>
            <input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}/>
          </label>
        </section>

        <nav className="model-registry-tabs" aria-label="模型设置分类">
          <button type="button" className={tab === 'providers' ? 'is-active' : ''} onClick={() => setTab('providers')}><Server size={16}/><span>供应商</span><b>{settings.providers.length}</b></button>
          <button type="button" className={tab === 'vision' ? 'is-active' : ''} onClick={() => setTab('vision')}><Eye size={16}/><span>视觉模型</span><b>{settings.visionModels.length}</b></button>
          <button type="button" className={tab === 'image' ? 'is-active' : ''} onClick={() => setTab('image')}><Image size={16}/><span>图像生成模型</span><b>{settings.imageModels.length}</b></button>
        </nav>

        <div className="model-registry-heading">
          <div><span className="kicker">{sectionMeta.eyebrow}</span><h3>{sectionMeta.title}</h3><p>{sectionMeta.description}</p></div>
          <button className="button button--light" type="button" onClick={tab === 'providers' ? addProvider : tab === 'vision' ? addVision : addImage}><Plus size={14}/> 新增{tab === 'providers' ? '供应商' : '模型'}</button>
        </div>

        {tab === 'providers' ? (
          <div className="model-registry-layout">
            <aside className="model-entity-list" aria-label="供应商列表">
              {settings.providers.map((provider) => {
                const modelCount = settings.visionModels.filter((model) => model.providerId === provider.id).length + settings.imageModels.filter((model) => model.providerId === provider.id).length
                return <button type="button" key={provider.id} className={provider.id === selectedProvider?.id ? 'is-active' : ''} onClick={() => setSelectedProviderId(provider.id)}>
                  <span className="model-entity-icon"><Server size={15}/></span><span><strong>{provider.name || '未命名供应商'}</strong><small>{provider.baseUrl || '等待填写 Base URL'}</small></span><em className={credentialStatus[provider.id] ? 'is-ready' : ''}>{credentialStatus[provider.id] ? 'KEY' : modelCount}</em>
                </button>
              })}
            </aside>
            {selectedProvider ? (
              <section className="module model-entity-editor model-form">
                <div className="module__heading"><div><span className="kicker">PROVIDER DETAIL</span><h3>{selectedProvider.name || '未命名供应商'}</h3></div><button className="icon-button icon-button--danger" type="button" title="删除供应商" onClick={() => deleteProvider(selectedProvider)}><Trash2 size={15}/></button></div>
                <div className="model-form-grid">
                  <label><span>供应商名称</span><input value={selectedProvider.name} onChange={(event) => updateProvider(selectedProvider.id, 'name', event.target.value)} placeholder="例如 OpenAI / Azure / 自建服务"/></label>
                  <label><span>API 类型</span><select value={selectedProvider.apiType} onChange={(event) => updateProvider(selectedProvider.id, 'apiType', event.target.value as ModelProvider['apiType'])}><option value="responses">/responses</option><option value="chat-completions">/chat/completions</option><option value="images-generations">/images/generations</option></select></label>
                  <label className="model-form-span"><span>Base URL</span><input value={selectedProvider.baseUrl} onChange={(event) => updateProvider(selectedProvider.id, 'baseUrl', event.target.value)} placeholder="https://api.example.com/v1"/></label>
                </div>
                <div className="provider-credential-block">
                  <div className="provider-credential-status"><LockKeyhole size={15}/><span><strong>API Key</strong><small>{credentialStatus[selectedProvider.id] ? '已安全保存在当前 Windows 用户账户' : '尚未配置该供应商凭据'}</small></span><b className={credentialStatus[selectedProvider.id] ? 'readout-ok' : ''}>{credentialStatus[selectedProvider.id] ? '已保存' : '未配置'}</b></div>
                  <label><span>{credentialStatus[selectedProvider.id] ? '输入新 Key 可覆盖当前凭据' : 'API Key'}</span><input type="password" autoComplete="off" value={apiKeyInputs[selectedProvider.id] || ''} onChange={(event) => setApiKeyInputs((current) => ({ ...current, [selectedProvider.id]: event.target.value }))} placeholder={credentialStatus[selectedProvider.id] ? '••••••••••••••••' : '输入供应商 API Key'}/></label>
                  <div className="credential-actions">
                    <button className="button button--dark" type="button" disabled={!credentialStatus[selectedProvider.id] || busyAction === `clear:${selectedProvider.id}`} onClick={() => void clearCredential(selectedProvider.id)}>{busyAction === `clear:${selectedProvider.id}` ? <LoaderCircle className="spin" size={14}/> : <X size={14}/>} 清除凭据</button>
                    <button className="button button--dark" type="button" disabled={busyAction === `test:${selectedProvider.id}`} onClick={() => void testProvider(selectedProvider)}>{busyAction === `test:${selectedProvider.id}` ? <LoaderCircle className="spin" size={14}/> : <KeyRound size={14}/>} 测试连接</button>
                  </div>
                </div>
              </section>
            ) : <EmptyRegistry icon={<Server size={24}/>} title="暂无供应商" description="添加供应商后即可维护连接信息与凭据。"/>}
          </div>
        ) : tab === 'vision' ? (
          <div className="model-registry-layout">
            <aside className="model-entity-list" aria-label="视觉模型列表">
              {settings.visionModels.map((model) => <button type="button" key={model.id} className={model.id === selectedVision?.id ? 'is-active' : ''} onClick={() => setSelectedVisionId(model.id)}>
                <span className="model-entity-icon"><Eye size={15}/></span><span><strong>{model.name || '未命名视觉模型'}</strong><small>{settings.providers.find((provider) => provider.id === model.providerId)?.name || '供应商已丢失'} · {model.model || '未填写模型 ID'}</small></span>{settings.activeVisionModelId === model.id ? <em className="is-ready">当前</em> : null}
              </button>)}
            </aside>
            {selectedVision ? (
              <section className="module model-entity-editor model-form">
                <div className="module__heading"><div><span className="kicker">VISION DETAIL</span><h3>{selectedVision.name || '未命名视觉模型'}</h3></div><button className="icon-button icon-button--danger" type="button" title="删除视觉模型" onClick={() => deleteVision(selectedVision)}><Trash2 size={15}/></button></div>
                <div className="model-form-grid">
                  <label><span>显示名称</span><input value={selectedVision.name} onChange={(event) => updateVision(selectedVision.id, 'name', event.target.value)} placeholder="例如 主力视觉模型"/></label>
                  <label><span>模型供应商</span><select value={selectedVision.providerId} onChange={(event) => updateVision(selectedVision.id, 'providerId', event.target.value)}>{settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
                  <label className="model-form-span"><span>API 模型 ID</span><input value={selectedVision.model} onChange={(event) => updateVision(selectedVision.id, 'model', event.target.value)} placeholder="填写支持图片输入的模型 ID"/></label>
                  <label><span>分析图片最长边</span><input type="number" min="512" max="4096" step="128" value={selectedVision.maxImageSide} onChange={(event) => updateVision(selectedVision.id, 'maxImageSide', Number(event.target.value))}/></label>
                  <label><span>请求超时（秒）</span><input type="number" min="10" max="600" value={selectedVision.timeoutSeconds} onChange={(event) => updateVision(selectedVision.id, 'timeoutSeconds', Number(event.target.value))}/></label>
                </div>
                <div className="model-active-action"><div><Eye size={15}/><span><strong>用于视觉分析</strong><small>AI 追色、配方分析和提示词优化将使用此模型。</small></span></div><button className={`button ${settings.activeVisionModelId === selectedVision.id ? 'button--dark is-selected' : 'button--accent'}`} type="button" onClick={() => onChange({ ...settings, activeVisionModelId: selectedVision.id })}>{settings.activeVisionModelId === selectedVision.id ? <Check size={14}/> : <WandSparkles size={14}/>} {settings.activeVisionModelId === selectedVision.id ? '当前视觉模型' : '设为当前'}</button></div>
              </section>
            ) : <EmptyRegistry icon={<Eye size={24}/>} title="暂无视觉模型" description="添加视觉模型以启用图片理解与调色配方分析。"/>}
          </div>
        ) : (
          <div className="model-registry-layout">
            <aside className="model-entity-list" aria-label="图像生成模型列表">
              {settings.imageModels.map((model) => <button type="button" key={model.id} className={model.id === selectedImage?.id ? 'is-active' : ''} onClick={() => setSelectedImageId(model.id)}>
                <span className="model-entity-icon"><Image size={15}/></span><span><strong>{model.name || '未命名图像模型'}</strong><small>{settings.providers.find((provider) => provider.id === model.providerId)?.name || '供应商已丢失'} · {model.model || '未填写模型 ID'}</small></span>{settings.activeImageModelId === model.id ? <em className="is-ready">当前</em> : null}
              </button>)}
            </aside>
            {selectedImage ? (
              <section className="module model-entity-editor model-form">
                <div className="module__heading"><div><span className="kicker">IMAGE MODEL DETAIL</span><h3>{selectedImage.name || '未命名图像模型'}</h3></div><button className="icon-button icon-button--danger" type="button" title="删除图像模型" onClick={() => deleteImage(selectedImage)}><Trash2 size={15}/></button></div>
                <div className="model-form-grid">
                  <label><span>显示名称</span><input value={selectedImage.name} onChange={(event) => updateImage(selectedImage.id, 'name', event.target.value)} placeholder="例如 高质量图像编辑"/></label>
                  <label><span>模型供应商</span><select value={selectedImage.providerId} onChange={(event) => changeImageProvider(selectedImage, event.target.value)}>{settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · /{provider.apiType === 'chat-completions' ? 'chat/completions' : provider.apiType === 'images-generations' ? 'images/generations' : 'responses'}</option>)}</select></label>
                  <label className="model-form-span"><span>API 模型 ID</span><input value={selectedImage.model} onChange={(event) => updateImage(selectedImage.id, 'model', event.target.value)} placeholder="填写图像生成或编辑模型 ID"/></label>
                  {!selectedImageUsesGenerations ? <label><span>输入图片最长边</span><input type="number" min="512" max="4096" step="128" value={selectedImage.maxImageSide} onChange={(event) => updateImage(selectedImage.id, 'maxImageSide', Number(event.target.value))}/></label> : null}
                  <label><span>生成超时（秒）</span><input type="number" min="30" max="1200" value={selectedImage.timeoutSeconds} onChange={(event) => updateImage(selectedImage.id, 'timeoutSeconds', Number(event.target.value))}/></label>
                </div>
                <div className="model-active-action"><div><Image size={15}/><span><strong>用于图像生成 / 编辑</strong><small>{selectedImageUsesGenerations ? '不上传原图；输出质量、尺寸、画风等参数在每次使用时配置。' : '会发送重编码图片；输出质量与尺寸在每次使用时配置。'}</small></span></div><button className={`button ${settings.activeImageModelId === selectedImage.id ? 'button--dark is-selected' : 'button--accent'}`} type="button" onClick={() => onChange({ ...settings, activeImageModelId: selectedImage.id })}>{settings.activeImageModelId === selectedImage.id ? <Check size={14}/> : <WandSparkles size={14}/>} {settings.activeImageModelId === selectedImage.id ? '当前图像模型' : '设为当前'}</button></div>
              </section>
            ) : <EmptyRegistry icon={<Image size={24}/>} title="暂无图像生成模型" description="添加模型后，图像编辑或纯文本生图会使用独立的供应商和凭据。"/>}
          </div>
        )}
      </div>

      <footer className="model-settings-actions">
        <div><LockKeyhole size={14}/><span>每个供应商的凭据独立存储在 Windows Credential Manager</span></div>
        <div><span className="model-settings-summary"><Boxes size={13}/>{settings.providers.length} 个供应商 · {settings.visionModels.length + settings.imageModels.length} 个模型</span><button className="button button--accent" type="button" disabled={!settingsLoaded || busyAction === 'save'} onClick={() => { setBusyAction('save'); void saveAll().catch((error) => notify(errorMessage(error, '保存模型设置失败'), 'error')).finally(() => setBusyAction('')) }}>{busyAction === 'save' ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>} 保存全部设置</button></div>
      </footer>
    </section>
  )
}

function EmptyRegistry({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <section className="module model-registry-empty"><span>{icon}</span><strong>{title}</strong><p>{description}</p></section>
}

