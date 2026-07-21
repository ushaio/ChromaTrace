use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "com.chromatrace.desktop";
const LEGACY_USER: &str = "model-api-key";
const LEGACY_PROVIDER_ID: &str = "provider-default";

fn validate_provider_id(provider_id: &str) -> Result<&str, String> {
    let trimmed = provider_id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 160
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("模型供应商标识无效".into());
    }
    Ok(trimmed)
}

fn entry(provider_id: &str) -> Result<Entry, String> {
    let provider_id = validate_provider_id(provider_id)?;
    Entry::new(SERVICE, &format!("model-api-key:{provider_id}"))
        .map_err(|error| format!("无法访问 Windows 凭据管理器：{error}"))
}

fn legacy_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, LEGACY_USER)
        .map_err(|error| format!("无法访问 Windows 凭据管理器：{error}"))
}

#[tauri::command]
pub fn save_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".into());
    }
    entry(&provider_id)?
        .set_password(trimmed)
        .map_err(|error| format!("保存 API Key 失败：{error}"))?;
    if provider_id == LEGACY_PROVIDER_ID {
        match legacy_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(_) => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_api_key(provider_id: String) -> Result<(), String> {
    match entry(&provider_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => {}
        Err(error) => return Err(format!("删除 API Key 失败：{error}")),
    }
    if provider_id == LEGACY_PROVIDER_ID {
        match legacy_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(format!("删除旧版 API Key 失败：{error}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn has_api_key(provider_id: String) -> Result<bool, String> {
    match entry(&provider_id)?.get_password() {
        Ok(value) => Ok(!value.trim().is_empty()),
        Err(KeyringError::NoEntry) if provider_id == LEGACY_PROVIDER_ID => {
            match legacy_entry()?.get_password() {
                Ok(value) => Ok(!value.trim().is_empty()),
                Err(KeyringError::NoEntry) => Ok(false),
                Err(error) => Err(format!("读取 API Key 状态失败：{error}")),
            }
        }
        Err(KeyringError::NoEntry) => Ok(false),
        Err(error) => Err(format!("读取 API Key 状态失败：{error}")),
    }
}

pub fn get_api_key(provider_id: &str) -> Result<String, String> {
    match entry(provider_id)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) | Err(KeyringError::NoEntry) if provider_id == LEGACY_PROVIDER_ID => {
            match legacy_entry()?.get_password() {
                Ok(value) if !value.trim().is_empty() => Ok(value),
                Ok(_) | Err(KeyringError::NoEntry) => Err("当前模型供应商尚未配置 API Key".into()),
                Err(error) => Err(format!("读取 API Key 失败：{error}")),
            }
        }
        Ok(_) | Err(KeyringError::NoEntry) => Err("当前模型供应商尚未配置 API Key".into()),
        Err(error) => Err(format!("读取 API Key 失败：{error}")),
    }
}
