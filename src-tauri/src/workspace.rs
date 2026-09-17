use crate::asset_library::library_root;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const WORKSPACE_VERSION: u32 = 1;
const DEFAULT_WORKSPACE_ID: &str = "default";
const MAX_WORKSPACE_PATH_DEPTH: usize = 9;
const COPY_BUFFER_SIZE: usize = 1024 * 1024;
const VOLUME_POLICY_FILE: &str = "volume-policy-v1.json";
const REGISTRY_FILE: &str = "workspaces.json";
const IMPORT_PROGRESS_EVENT: &str = "workspace-import-progress";

static IMPORT_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static WORKSPACE_MANIFEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static WORKSPACE_REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVolume {
    pub root_path: String,
    pub volume_id: String,
    pub label: String,
    pub drive_type: String,
    pub recommendation: String,
    pub remembered_policy: Option<String>,
    pub file_count: u32,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportEntry {
    pub source_path: String,
    pub volume_id: String,
    pub relative_source_path: String,
    pub target_relative: String,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportProgress {
    pub job_id: String,
    pub phase: String,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub copied_files: u32,
    pub total_files: u32,
    pub percent: f64,
    pub current_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceReference {
    pub id: String,
    pub origin: String,
    pub volume_id: String,
    pub relative_source_path: String,
    pub source_path: String,
    pub workspace_path: Option<String>,
    pub status: String,
    pub stats: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspacePhoto {
    pub id: String,
    pub volume_id: String,
    pub relative_source_path: String,
    pub source_path: String,
    pub origin: String,
    pub workspace_path: Option<String>,
    pub status: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub is_raw: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumb_key: Option<String>,
    pub stats: Option<Value>,
    pub reference_override: Option<WorkspaceReference>,
    pub develop: Option<Value>,
    pub edited_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceManifest {
    pub version: u32,
    pub id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub revision: u64,
    pub reference: Option<WorkspaceReference>,
    pub photos: Vec<WorkspacePhoto>,
}

impl Default for WorkspaceManifest {
    fn default() -> Self {
        let now = now_ms();
        Self {
            version: WORKSPACE_VERSION,
            id: DEFAULT_WORKSPACE_ID.into(),
            created_at: now,
            updated_at: now,
            revision: 0,
            reference: None,
            photos: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportFailure {
    pub source_path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportReport {
    pub manifest: WorkspaceManifest,
    pub imported: Vec<WorkspacePhoto>,
    pub skipped: Vec<String>,
    pub failed: Vec<WorkspaceImportFailure>,
    pub copied_bytes: u64,
    pub copied_files: u32,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiskSpace {
    pub path: String,
    pub available_bytes: u64,
    pub total_bytes: u64,
}

/// 工作区注册表条目：只存名称等元数据，不存张数与封面。
///
/// 张数 / 封面由前端按需读各工作区的 manifest 惰性补全，避免注册表与 manifest 产生
/// 第二份需要保持一致的真相源（改名因此不会触发 manifest 的 revision 乐观并发）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WorkspaceRegistry {
    version: u32,
    workspaces: Vec<WorkspaceInfo>,
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join(REGISTRY_FILE))
}

/// 注册表原子写入：与 manifest 同策略（临时文件 → Windows 上先备份再替换）。
fn write_registry_atomic(app: &AppHandle, registry: &WorkspaceRegistry) -> Result<(), String> {
    let library = library_root(app)?;
    fs::create_dir_all(&library).map_err(|error| format!("无法创建资料库目录：{error}"))?;
    let path = library.join(REGISTRY_FILE);
    let temporary = library.join(format!("{REGISTRY_FILE}.tmp"));
    let data = serde_json::to_vec_pretty(registry)
        .map_err(|error| format!("无法序列化工作区注册表：{error}"))?;
    let mut file =
        File::create(&temporary).map_err(|error| format!("无法创建注册表临时文件：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("无法写入工作区注册表：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("无法完成工作区注册表写入：{error}"))?;
    drop(file);
    #[cfg(target_os = "windows")]
    if path.exists() {
        let backup = library.join(format!("{REGISTRY_FILE}.bak"));
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("无法备份工作区注册表：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &path) {
            let _ = fs::rename(&backup, &path);
            return Err(format!("无法启用工作区注册表：{error}"));
        }
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    fs::rename(&temporary, &path).map_err(|error| format!("无法启用工作区注册表：{error}"))
}

fn read_registry(app: &AppHandle) -> WorkspaceRegistry {
    let Ok(path) = registry_path(app) else {
        return WorkspaceRegistry::default();
    };
    let Ok(data) = fs::read(&path) else {
        return WorkspaceRegistry::default();
    };
    match serde_json::from_slice::<WorkspaceRegistry>(&data) {
        Ok(mut registry) => {
            registry.version = WORKSPACE_VERSION;
            registry
                .workspaces
                .retain(|entry| normalize_workspace_id(&entry.id).is_ok());
            registry
        }
        Err(error) => {
            log::warn!("工作区注册表无法解析，将回退为自动重建：{error}");
            WorkspaceRegistry::default()
        }
    }
}

/// 列出 `workspaces/` 下真实存在的目录 id（用于给注册表补漏 / 清理幽灵条目）。
fn scan_workspace_dirs(app: &AppHandle) -> Vec<String> {
    let Ok(library) = library_root(app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(library.join("workspaces")) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| normalize_workspace_id(name).is_ok())
        .collect();
    ids.sort();
    ids
}

/// 读取注册表，并用磁盘上真实存在的工作区目录补齐缺失条目、剔除幽灵条目。
///
/// 首次运行（无注册表）时以现有 `default` 目录播种；注册表存在但磁盘目录被手工删除时，
/// 该条目会被剔除，因此前端 localStorage 里的失效 id 能通过 `list_workspaces` 结果比对出来。
fn load_registry(app: &AppHandle) -> Result<WorkspaceRegistry, String> {
    let mut registry = read_registry(app);
    let existing = scan_workspace_dirs(app);
    let mut changed = registry.workspaces.is_empty() && !existing.is_empty();

    // 剔除磁盘上已不存在的幽灵条目。
    let before = registry.workspaces.len();
    registry
        .workspaces
        .retain(|entry| existing.contains(&entry.id));
    if registry.workspaces.len() != before {
        changed = true;
    }

    // 补齐磁盘上存在但注册表缺失的条目（含首次运行的 default 播种）。
    let known: Vec<String> = registry
        .workspaces
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    for id in &existing {
        if known.contains(id) {
            continue;
        }
        let now = now_ms();
        let created_at = fs::metadata(library_root(app)?.join("workspaces").join(id))
            .ok()
            .and_then(|meta| meta.created().or_else(|_| meta.modified()).ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(now);
        registry.workspaces.push(WorkspaceInfo {
            id: id.clone(),
            name: id.clone(),
            created_at,
            updated_at: now,
        });
        changed = true;
    }

    if changed {
        write_registry_atomic(app, &registry)?;
    }
    Ok(registry)
}

/// 由名称派生一个安全的工作区 id（小写、连字符分隔），冲突时追加序号。
fn derive_workspace_id(name: &str, taken: &[String]) -> String {
    let mut base: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_digit() {
                ch
            } else {
                '-'
            }
        })
        .collect();
    while base.contains("--") {
        base = base.replace("--", "-");
    }
    base = base.trim_matches('-').to_string();
    if base.is_empty() {
        base = "workspace".into();
    }
    // 保留 id 长度可控，避免派生超长目录名。
    base.truncate(48);
    base = base.trim_matches('-').to_string();
    if base.is_empty() {
        base = "workspace".into();
    }
    if normalize_workspace_id(&base).is_err() || !taken.contains(&base) {
        return base;
    }
    for index in 2..1000 {
        let candidate = format!("{base}-{index}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", now_ms())
}

fn validate_workspace_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("工作区名称不能为空".into());
    }
    if name.chars().count() > 48 {
        return Err("工作区名称不能超过 48 个字符".into());
    }
    if name.chars().any(|ch| ch.is_control() || ch == '\0') {
        return Err("工作区名称包含非法字符".into());
    }
    Ok(name.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_workspace_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err("工作区标识无效".into());
    }
    if id
        .chars()
        .any(|ch| ch.is_control() || ch == ':' || ch == '\0')
    {
        return Err("工作区标识包含非法字符".into());
    }
    Ok(id.to_string())
}

fn workspace_dir(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    Ok(library_root(app)?
        .join("workspaces")
        .join(normalize_workspace_id(workspace_id)?))
}

fn ensure_workspace_dirs(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    let root = workspace_dir(app, workspace_id)?;
    let library = library_root(app)?;
    fs::create_dir_all(&library).map_err(|error| format!("无法创建资料库目录：{error}"))?;
    let workspaces = library.join("workspaces");
    fs::create_dir_all(&workspaces).map_err(|error| format!("无法创建工作区目录：{error}"))?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建工作区目录：{error}"))?;
    let canonical_workspaces =
        fs::canonicalize(&workspaces).map_err(|error| format!("无法解析工作区根目录：{error}"))?;
    let canonical_root =
        fs::canonicalize(&root).map_err(|error| format!("无法解析工作区目录：{error}"))?;
    if !path_is_within(&canonical_root, &canonical_workspaces) {
        return Err("工作区目录路径越界".into());
    }
    if fs::symlink_metadata(&root)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("工作区目录不能是符号链接".into());
    }
    for name in ["originals", "references", "thumbs"] {
        fs::create_dir_all(root.join(name))
            .map_err(|error| format!("无法创建工作区目录：{error}"))?;
    }
    Ok(root)
}

fn normalize_relative_path(raw: &str) -> Result<String, String> {
    let value = raw.replace('\\', "/");
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('~')
        || trimmed.as_bytes().get(1) == Some(&b':')
    {
        return Err("工作区相对路径无效".into());
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("工作区相对路径不能包含上级目录".into());
        }
        if part.chars().any(|ch| ch.is_control() || ch == ':') {
            return Err("工作区相对路径包含非法字符".into());
        }
        let part = part.trim().trim_matches('.');
        if part.is_empty() {
            return Err("工作区相对路径包含空文件名".into());
        }
        parts.push(part.to_string());
    }
    if parts.is_empty() || parts.len() > MAX_WORKSPACE_PATH_DEPTH {
        return Err("工作区相对路径无效或层级过深".into());
    }
    Ok(parts.join("/"))
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(target_os = "windows") {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn path_is_within(path: &Path, parent: &Path) -> bool {
    let path = path_key(path);
    let parent = path_key(parent).trim_end_matches('/').to_string();
    path == parent || path.starts_with(&format!("{parent}/"))
}

fn safe_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(relative)?;
    let target = root.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR));
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("无法解析工作区目录：{error}"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建工作区子目录：{error}"))?;
        let canonical_parent =
            fs::canonicalize(parent).map_err(|error| format!("无法解析工作区目标目录：{error}"))?;
        if !path_is_within(&canonical_parent, &canonical_root) {
            return Err("工作区目标路径越界".into());
        }
    }
    if target.exists() {
        let canonical_target = fs::canonicalize(&target)
            .map_err(|error| format!("无法解析工作区目标路径：{error}"))?;
        if !path_is_within(&canonical_target, &canonical_root) {
            return Err("工作区目标路径越界".into());
        }
    }
    Ok(target)
}

/// 计算原片的副本落点。`copy` 落到 `originals/`，`reference` 不产生副本（返回 `None`）。
fn photo_target_relative(origin: &str, raw: &str) -> Result<Option<String>, String> {
    let normalized = normalize_relative_path(raw)?;
    if normalized == "originals" || normalized == "references" {
        return Err("工作区目标必须是文件路径".into());
    }
    if normalized.starts_with("originals/") || normalized.starts_with("references/") {
        if origin != "copy" || !normalized.starts_with("originals/") {
            return Err("工作区目标目录与来源类型不匹配".into());
        }
        return Ok(Some(normalized));
    }
    match origin {
        "copy" => Ok(Some(format!("originals/{normalized}"))),
        "reference" => Ok(None),
        _ => Err("导入来源类型无效".into()),
    }
}

/// 参考图副本落点：参考图独立于原片，统一落在 `references/`。
fn reference_target_relative(raw: &str) -> Result<String, String> {
    let normalized = normalize_relative_path(raw)?;
    if normalized.starts_with("references/") {
        return Ok(normalized);
    }
    if normalized == "references"
        || normalized == "originals"
        || normalized.starts_with("originals/")
    {
        return Err("参考图目标路径无效".into());
    }
    Ok(format!("references/{normalized}"))
}

fn read_manifest_file(root: &Path, workspace_id: &str) -> Option<WorkspaceManifest> {
    let data = fs::read(root.join("manifest.json")).ok()?;
    match serde_json::from_slice::<WorkspaceManifest>(&data) {
        Ok(mut manifest) => {
            manifest.id = normalize_workspace_id(workspace_id).ok()?;
            manifest.version = WORKSPACE_VERSION;
            Some(manifest)
        }
        Err(error) => {
            log::warn!("工作区 manifest 无法解析，将回退为空工作区：{error}");
            None
        }
    }
}

fn default_manifest(workspace_id: &str) -> Result<WorkspaceManifest, String> {
    let mut manifest = WorkspaceManifest::default();
    manifest.id = normalize_workspace_id(workspace_id)?;
    Ok(manifest)
}

fn write_manifest_atomic(root: &Path, manifest: &WorkspaceManifest) -> Result<(), String> {
    let path = root.join("manifest.json");
    let temporary = root.join("manifest.json.tmp");
    let data = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("无法序列化工作区 manifest：{error}"))?;
    let mut file = File::create(&temporary)
        .map_err(|error| format!("无法创建工作区 manifest 临时文件：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("无法写入工作区 manifest：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("无法完成工作区 manifest 写入：{error}"))?;
    drop(file);
    #[cfg(target_os = "windows")]
    if path.exists() {
        let backup = root.join("manifest.json.bak");
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("无法备份工作区 manifest：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &path) {
            let _ = fs::rename(&backup, &path);
            return Err(format!("无法启用工作区 manifest：{error}"));
        }
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    fs::rename(&temporary, &path).map_err(|error| format!("无法启用工作区 manifest：{error}"))
}

fn persist_manifest(root: &Path, manifest: &mut WorkspaceManifest) -> Result<(), String> {
    manifest.version = WORKSPACE_VERSION;
    manifest.updated_at = now_ms();
    manifest.revision = manifest.revision.saturating_add(1);
    validate_manifest(manifest)?;
    write_manifest_atomic(root, manifest)
}

fn recover_manifest(root: &Path, mut manifest: WorkspaceManifest) -> (WorkspaceManifest, bool) {
    let mut changed = false;
    for photo in &mut manifest.photos {
        if photo.origin != "copy" {
            continue;
        }
        let valid = photo
            .workspace_path
            .as_deref()
            .map(|path| {
                let target = root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
                target.is_file()
                    && fs::metadata(target)
                        .map(|meta| meta.len() == photo.size_bytes)
                        .unwrap_or(false)
            })
            .unwrap_or(false);
        if !valid && matches!(photo.status.as_str(), "ready" | "copying") {
            photo.status = "pending".into();
            changed = true;
        }
    }
    (manifest, changed)
}

fn normalize_manifest(manifest: &mut WorkspaceManifest, workspace_id: &str) -> Result<(), String> {
    manifest.id = normalize_workspace_id(workspace_id)?;
    manifest.version = WORKSPACE_VERSION;
    if manifest.created_at == 0 {
        manifest.created_at = now_ms();
    }
    for photo in &mut manifest.photos {
        if photo.status.is_empty() {
            photo.status = if photo.origin == "copy" {
                "pending"
            } else {
                "ready"
            }
            .into();
        }
        if let Some(path) = photo.workspace_path.as_mut() {
            *path = normalize_relative_path(path)?;
        }
    }
    Ok(())
}

fn validate_manifest(manifest: &WorkspaceManifest) -> Result<(), String> {
    for photo in &manifest.photos {
        if let Some(path) = &photo.workspace_path {
            let normalized = normalize_relative_path(path)?;
            let expected = match photo.origin.as_str() {
                "copy" => "originals/",
                "reference" => "references/",
                _ => return Err("manifest 中存在无效来源类型".into()),
            };
            if !normalized.starts_with(expected) {
                return Err("manifest 中存在不匹配的工作区路径".into());
            }
        }
    }
    if let Some(reference) = &manifest.reference {
        if let Some(path) = &reference.workspace_path {
            if !normalize_relative_path(path)?.starts_with("references/") {
                return Err("manifest 参考图路径无效".into());
            }
        }
    }
    Ok(())
}

fn load_manifest(root: &Path, workspace_id: &str) -> Result<WorkspaceManifest, String> {
    let mut manifest =
        read_manifest_file(root, workspace_id).unwrap_or(default_manifest(workspace_id)?);
    normalize_manifest(&mut manifest, workspace_id)?;
    let (manifest, changed) = recover_manifest(root, manifest);
    if changed {
        let mut copy = manifest.clone();
        persist_manifest(root, &mut copy)?;
    }
    Ok(manifest)
}

#[tauri::command]
pub fn list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceInfo>, String> {
    let _guard = WORKSPACE_REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "工作区注册表锁不可用")?;
    Ok(load_registry(&app)?.workspaces)
}

#[tauri::command]
pub fn create_workspace(app: AppHandle, name: String) -> Result<WorkspaceInfo, String> {
    let name = validate_workspace_name(&name)?;
    let _guard = WORKSPACE_REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "工作区注册表锁不可用")?;
    let mut registry = load_registry(&app)?;
    let taken: Vec<String> = registry
        .workspaces
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    let id = derive_workspace_id(&name, &taken);
    // 先建目录（含 originals / references / thumbs）再登记，避免注册表出现无目录的条目。
    ensure_workspace_dirs(&app, &id)?;
    let now = now_ms();
    let info = WorkspaceInfo {
        id,
        name,
        created_at: now,
        updated_at: now,
    };
    registry.workspaces.push(info.clone());
    write_registry_atomic(&app, &registry)?;
    Ok(info)
}

#[tauri::command]
pub fn rename_workspace(
    app: AppHandle,
    workspace_id: String,
    name: String,
) -> Result<WorkspaceInfo, String> {
    let id = normalize_workspace_id(&workspace_id)?;
    let name = validate_workspace_name(&name)?;
    let _guard = WORKSPACE_REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "工作区注册表锁不可用")?;
    let mut registry = load_registry(&app)?;
    let entry = registry
        .workspaces
        .iter_mut()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "工作区不存在".to_string())?;
    entry.name = name;
    entry.updated_at = now_ms();
    let info = entry.clone();
    write_registry_atomic(&app, &registry)?;
    Ok(info)
}

/// 删除工作区：删除注册表条目与整个工作区目录（含 originals / references / thumbs）。
///
/// 拒绝删除最后一个工作区，避免前端进入「无任何工作区」的不可恢复状态。
#[tauri::command]
pub fn delete_workspace(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let id = normalize_workspace_id(&workspace_id)?;
    let _guard = WORKSPACE_REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "工作区注册表锁不可用")?;
    let mut registry = load_registry(&app)?;
    if !registry.workspaces.iter().any(|entry| entry.id == id) {
        return Err("工作区不存在".into());
    }
    if registry.workspaces.len() <= 1 {
        return Err("至少需要保留一个工作区".into());
    }
    let root = workspace_dir(&app, &id)?;
    let workspaces = library_root(&app)?.join("workspaces");
    // 越界校验：确认待删目录确实位于 workspaces/ 之下，且不是符号链接。
    if let (Ok(canonical_root), Ok(canonical_workspaces)) =
        (fs::canonicalize(&root), fs::canonicalize(&workspaces))
    {
        if !path_is_within(&canonical_root, &canonical_workspaces) {
            return Err("工作区目录路径越界".into());
        }
        if canonical_root == canonical_workspaces {
            return Err("工作区目录路径越界".into());
        }
    }
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|error| format!("无法删除工作区目录：{error}"))?;
    }
    registry.workspaces.retain(|entry| entry.id != id);
    write_registry_atomic(&app, &registry)?;
    Ok(())
}

#[tauri::command]
pub fn read_workspace_manifest(
    app: AppHandle,
    workspace_id: String,
) -> Result<WorkspaceManifest, String> {
    let _guard = WORKSPACE_MANIFEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "工作区正在写入，请稍候".to_string())?;
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let manifest = load_manifest(&root, &workspace_id)?;
    if !root.join("manifest.json").is_file() {
        write_manifest_atomic(&root, &manifest)?;
    }
    Ok(manifest)
}

pub(crate) fn system_time_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn sha1_hex(value: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 缩略图缓存的 maxSide 约定。前端 `src/lib/thumbnails.ts` 必须与之一致。
pub const THUMBNAIL_MAX_SIDE: u32 = 256;

/// 缩略图缓存键。三处不变量：
/// * 用 `volumeId` 而非盘符——换 USB 口重新分配盘符后缓存仍应命中；
/// * 卷内相对路径做 ASCII 小写归一，避免同一张图因大小写不同产生两份缓存；
/// * `size` / `mtime` 参与摘要，源文件被替换必然导致 key 变化，无需额外失效状态。
fn thumb_key(
    volume_id: &str,
    relative_path: &str,
    size_bytes: u64,
    mtime_ms: u64,
    max_side: u32,
) -> String {
    sha1_hex(&format!(
        "{volume_id}|{}|{size_bytes}|{mtime_ms}|{max_side}",
        relative_path.to_ascii_lowercase()
    ))
}

fn normalized_volume_root(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(root) = windows_volume_root(path) {
            return root;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(root) = unix_volume_root(path) {
            return root;
        }
    }
    path.parent().unwrap_or(path).to_path_buf()
}

fn parse_volume_id_policy(root: &Path) -> (String, String, String) {
    #[cfg(target_os = "windows")]
    if let Some(value) = windows_volume_info(root) {
        return value;
    }
    (
        format!("path:{}", path_key(root)),
        root.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("未命名卷")
            .to_string(),
        "unknown".into(),
    )
}

fn recommendation_for_drive_type(drive_type: &str) -> &'static str {
    if drive_type == "fixed" {
        "reference"
    } else {
        "copy"
    }
}

/// 卷策略记忆：按 `volumeId` 记住用户对该卷的复制 / 引用选择。
///
/// 键必须是卷标识而非盘符——否则换一次盘符就要重问一次。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VolumePolicyRecord {
    pub policy: String,
    /// 卷标，仅用于在「设置 → 资料库 → 卷记忆」里让用户认得出是哪块盘。
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub updated_at: u64,
}

/// 解析卷策略文件。兼容两种历史形态：裸字符串（`"copy"`）与记录对象。
fn parse_volume_policies(data: &[u8]) -> HashMap<String, VolumePolicyRecord> {
    let parsed: HashMap<String, Value> = serde_json::from_slice(data).unwrap_or_default();
    parsed
        .into_iter()
        .filter_map(|(volume_id, value)| {
            let record = match value {
                Value::String(policy) => VolumePolicyRecord {
                    policy,
                    label: String::new(),
                    updated_at: 0,
                },
                Value::Object(map) => VolumePolicyRecord {
                    policy: map
                        .get("policy")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    label: map
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    updated_at: map.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
                },
                _ => return None,
            };
            if record.policy != "copy" && record.policy != "reference" {
                return None;
            }
            Some((volume_id, record))
        })
        .collect()
}

fn load_volume_policies(app: &AppHandle) -> HashMap<String, VolumePolicyRecord> {
    let Ok(root) = library_root(app) else {
        return HashMap::new();
    };
    let path = root.join(VOLUME_POLICY_FILE);
    let Ok(data) = fs::read(path) else {
        return HashMap::new();
    };
    parse_volume_policies(&data)
}

fn save_volume_policies(
    app: &AppHandle,
    policies: &HashMap<String, VolumePolicyRecord>,
) -> Result<(), String> {
    let root = library_root(app)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建资料库目录：{error}"))?;
    let path = root.join(VOLUME_POLICY_FILE);
    let temporary = root.join(format!("{VOLUME_POLICY_FILE}.tmp"));
    let data = serde_json::to_vec_pretty(policies)
        .map_err(|error| format!("无法序列化卷策略：{error}"))?;
    fs::write(&temporary, data).map_err(|error| format!("无法保存卷策略：{error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法启用卷策略：{error}"))
}

#[cfg(target_os = "windows")]
fn windows_wide(value: &Path) -> Vec<u16> {
    value
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn windows_volume_root(path: &Path) -> Option<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
    let text = windows_wide(path);
    let mut buffer = [0u16; 512];
    unsafe {
        GetVolumePathNameW(PCWSTR(text.as_ptr()), &mut buffer).ok()?;
    }
    let end = buffer.iter().position(|value| *value == 0)?;
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
}

#[cfg(target_os = "windows")]
fn windows_volume_info(root: &Path) -> Option<(String, String, String)> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW};
    let text = windows_wide(root);
    let drive_type = unsafe { GetDriveTypeW(PCWSTR(text.as_ptr())) };
    let (kind, name) = match drive_type {
        2 => ("removable", "可移动设备"),
        3 => ("fixed", "固定磁盘"),
        4 => ("remote", "网络磁盘"),
        5 => ("cdrom", "光盘"),
        6 => ("ramdisk", "内存盘"),
        _ => ("unknown", "未知设备"),
    };
    let mut label = [0u16; 256];
    let mut serial = 0u32;
    let mut max_component = 0u32;
    let mut flags = 0u32;
    let mut filesystem = [0u16; 64];
    unsafe {
        GetVolumeInformationW(
            PCWSTR(text.as_ptr()),
            Some(&mut label),
            Some(&mut serial),
            Some(&mut max_component),
            Some(&mut flags),
            Some(&mut filesystem),
        )
        .ok()?;
    }
    let label_end = label
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(label.len());
    let label = String::from_utf16_lossy(&label[..label_end]);
    let volume_id = format!("{serial:08X}");
    Some((
        volume_id,
        if label.is_empty() { name.into() } else { label },
        kind.into(),
    ))
}

#[cfg(not(target_os = "windows"))]
fn unix_volume_root(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    if cfg!(target_os = "macos") {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix("/Volumes/") {
            let name = rest.split('/').next().filter(|value| !value.is_empty())?;
            return Some(PathBuf::from("/Volumes").join(name));
        }
    }
    Some(PathBuf::from("/"))
}

fn read_volume_mount_from_id(volume_id: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{GetLogicalDriveStringsW, GetVolumeInformationW};
        let mut buffer = [0u16; 512];
        let length = unsafe { GetLogicalDriveStringsW(Some(&mut buffer)) } as usize;
        if length == 0 || length >= buffer.len() {
            return None;
        }
        let mut start = 0;
        while start < length {
            let end = buffer[start..length]
                .iter()
                .position(|value| *value == 0)
                .map(|offset| start + offset)
                .unwrap_or(length);
            if end == start {
                break;
            }
            let drive = PathBuf::from(String::from_utf16_lossy(&buffer[start..end]));
            let text = windows_wide(&drive);
            let mut label = [0u16; 256];
            let mut serial = 0u32;
            let mut max_component = 0u32;
            let mut flags = 0u32;
            let mut filesystem = [0u16; 64];
            let ok = unsafe {
                GetVolumeInformationW(
                    PCWSTR(text.as_ptr()),
                    Some(&mut label),
                    Some(&mut serial),
                    Some(&mut max_component),
                    Some(&mut flags),
                    Some(&mut filesystem),
                )
                .is_ok()
            };
            if ok && format!("{serial:08X}").eq_ignore_ascii_case(volume_id) {
                return Some(drive);
            }
            start = end + 1;
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        volume_id
            .strip_prefix("path:")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
    }
}

fn source_volume_for_path(path: &Path) -> (PathBuf, String, String, String) {
    let root = normalized_volume_root(path);
    let (volume_id, label, drive_type) = parse_volume_id_policy(&root);
    (root, volume_id, label, drive_type)
}

#[tauri::command]
pub fn classify_source_volumes(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<SourceVolume>, String> {
    let policies = load_volume_policies(&app);
    let mut grouped: HashMap<String, (PathBuf, String, String, String, u32, u64)> = HashMap::new();
    for raw_path in paths {
        let path = PathBuf::from(&raw_path);
        let metadata = match fs::metadata(&path) {
            Ok(value) if value.is_file() => value,
            _ => continue,
        };
        let (root, volume_id, label, drive_type) = source_volume_for_path(&path);
        let entry = grouped
            .entry(volume_id.clone())
            .or_insert((root, volume_id, label, drive_type, 0, 0));
        entry.4 = entry.4.saturating_add(1);
        entry.5 = entry.5.saturating_add(metadata.len());
    }
    let mut volumes = grouped
        .into_values()
        .map(
            |(root, volume_id, label, drive_type, file_count, total_bytes)| {
                let remembered_policy = policies
                    .get(&volume_id)
                    .map(|record| record.policy.clone())
                    .filter(|value| value.as_str() == "copy" || value.as_str() == "reference");
                let recommendation = remembered_policy
                    .clone()
                    .unwrap_or_else(|| recommendation_for_drive_type(&drive_type).into());
                SourceVolume {
                    root_path: root.to_string_lossy().into_owned(),
                    volume_id,
                    label,
                    drive_type,
                    recommendation,
                    remembered_policy,
                    file_count,
                    total_bytes,
                }
            },
        )
        .collect::<Vec<_>>();
    volumes.sort_by(|left, right| {
        left.root_path
            .to_ascii_lowercase()
            .cmp(&right.root_path.to_ascii_lowercase())
    });
    Ok(volumes)
}

#[tauri::command]
pub fn resolve_volume_mount(volume_id: String) -> Result<Option<String>, String> {
    Ok(read_volume_mount_from_id(volume_id.trim()).map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn get_volume_policies(app: AppHandle) -> Result<HashMap<String, VolumePolicyRecord>, String> {
    Ok(load_volume_policies(&app))
}

#[tauri::command]
pub fn set_volume_policy(
    app: AppHandle,
    volume_id: String,
    policy: String,
    label: Option<String>,
) -> Result<(), String> {
    if policy != "copy" && policy != "reference" {
        return Err("卷策略必须是 copy 或 reference".into());
    }
    let id = volume_id.trim();
    if id.is_empty() {
        return Err("卷标识无效".into());
    }
    let mut policies = load_volume_policies(&app);
    let label = label.unwrap_or_default().trim().to_string();
    let previous = policies.get(id);
    policies.insert(
        id.to_string(),
        VolumePolicyRecord {
            policy,
            // 后续再写入时若没带卷标，保留上一次已知的卷标。
            label: if label.is_empty() {
                previous
                    .map(|record| record.label.clone())
                    .unwrap_or_default()
            } else {
                label
            },
            updated_at: now_ms(),
        },
    );
    save_volume_policies(&app, &policies)
}

#[tauri::command]
pub fn clear_volume_policies(app: AppHandle) -> Result<(), String> {
    save_volume_policies(&app, &HashMap::new())
}

/// 单独清除某个卷的记忆，供「设置 → 资料库 → 卷记忆」使用。
#[tauri::command]
pub fn clear_volume_policy(app: AppHandle, volume_id: String) -> Result<(), String> {
    let mut policies = load_volume_policies(&app);
    policies.remove(volume_id.trim());
    save_volume_policies(&app, &policies)
}

// ---------------------------------------------------------------------------
// 导入管线
// ---------------------------------------------------------------------------

fn emit_import_progress(
    app: &AppHandle,
    job_id: &str,
    phase: &str,
    copied_bytes: u64,
    total_bytes: u64,
    copied_files: u32,
    total_files: u32,
    current_file: Option<String>,
) {
    let percent = if phase == "completed" {
        100.0
    } else if total_bytes > 0 {
        (copied_bytes as f64 / total_bytes as f64 * 98.0).min(98.0)
    } else if total_files > 0 {
        (copied_files as f64 / total_files as f64 * 98.0).min(98.0)
    } else if phase == "finalizing" {
        99.0
    } else {
        0.0
    };
    let _ = app.emit(
        IMPORT_PROGRESS_EVENT,
        WorkspaceImportProgress {
            job_id: job_id.to_string(),
            phase: phase.to_string(),
            copied_bytes,
            total_bytes,
            copied_files,
            total_files,
            percent,
            current_file,
        },
    );
}

fn cancellation_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    IMPORT_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cancellation(job_id: &str) -> Arc<AtomicBool> {
    let registry = cancellation_registry();
    let mut guard = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let flag = Arc::new(AtomicBool::new(false));
    guard.insert(job_id.to_string(), flag.clone());
    flag
}

fn release_cancellation(job_id: &str) {
    let registry = cancellation_registry();
    if let Ok(mut guard) = registry.lock() {
        guard.remove(job_id);
    }
}

fn manifest_lock() -> &'static Mutex<()> {
    WORKSPACE_MANIFEST_LOCK.get_or_init(|| Mutex::new(()))
}

fn copy_file_streaming(
    app: &AppHandle,
    job_id: &str,
    source: &Path,
    target: &Path,
    display: &str,
    copied_bytes: &mut u64,
    total_bytes: u64,
    copied_files: u32,
    total_files: u32,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建副本目录：{error}"))?;
    }
    let mut reader = File::open(source)
        .map_err(|error| format!("无法读取源文件 {}：{error}", source.display()))?;
    let mut writer = File::create(target)
        .map_err(|error| format!("无法创建副本 {}：{error}", target.display()))?;
    let mut buffer = vec![0u8; COPY_BUFFER_SIZE];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取源文件失败 {}：{error}", source.display()))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入副本失败 {}：{error}", target.display()))?;
        *copied_bytes = copied_bytes.saturating_add(read as u64);
        emit_import_progress(
            app,
            job_id,
            "copying",
            *copied_bytes,
            total_bytes,
            copied_files,
            total_files,
            Some(display.to_string()),
        );
    }
    writer
        .sync_all()
        .map_err(|error| format!("无法完成副本写入 {}：{error}", target.display()))?;
    Ok(())
}

/// 把一个条目的最新状态合并回磁盘 manifest（短临界区，不跨复制过程持锁）。
fn update_photo_status<F>(
    root: &Path,
    workspace_id: &str,
    photo_id: &str,
    apply: F,
) -> Result<(), String>
where
    F: FnOnce(&mut WorkspacePhoto),
{
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "工作区正在写入，请稍候".to_string())?;
    let mut manifest = load_manifest(root, workspace_id)?;
    if let Some(photo) = manifest
        .photos
        .iter_mut()
        .find(|photo| photo.id == photo_id)
    {
        apply(photo);
    }
    persist_manifest(root, &mut manifest)
}

fn import_workspace_files_blocking(
    app: AppHandle,
    workspace_id: String,
    entries: Vec<WorkspaceImportEntry>,
    job_id: String,
) -> Result<WorkspaceImportReport, String> {
    if entries.is_empty() {
        return Err("没有需要导入的文件".into());
    }
    let flag = register_cancellation(&job_id);
    let outcome = import_workspace_entries(&app, &workspace_id, entries, &job_id, &flag);
    release_cancellation(&job_id);
    outcome
}

fn import_workspace_entries(
    app: &AppHandle,
    workspace_id: &str,
    entries: Vec<WorkspaceImportEntry>,
    job_id: &str,
    flag: &Arc<AtomicBool>,
) -> Result<WorkspaceImportReport, String> {
    let root = ensure_workspace_dirs(app, workspace_id)?;
    let mut failed: Vec<WorkspaceImportFailure> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut planned: Vec<(String, PathBuf, String, u64, u64)> = Vec::new();
    let mut registered: Vec<String> = Vec::new();

    emit_import_progress(app, job_id, "preparing", 0, 0, 0, 0, None);

    {
        let _guard = manifest_lock()
            .lock()
            .map_err(|_| "工作区正在写入，请稍候".to_string())?;
        let mut manifest = load_manifest(&root, workspace_id)?;
        for entry in &entries {
            let origin = entry.origin.trim();
            if origin != "copy" && origin != "reference" {
                failed.push(WorkspaceImportFailure {
                    source_path: entry.source_path.clone(),
                    error: "导入来源类型无效".into(),
                });
                continue;
            }
            let volume_id = entry.volume_id.trim();
            if volume_id.is_empty() {
                failed.push(WorkspaceImportFailure {
                    source_path: entry.source_path.clone(),
                    error: "缺少卷标识，无法确认图片来源".into(),
                });
                continue;
            }
            let relative_source = match normalize_relative_path(&entry.relative_source_path) {
                Ok(value) => value,
                Err(error) => {
                    failed.push(WorkspaceImportFailure {
                        source_path: entry.source_path.clone(),
                        error,
                    });
                    continue;
                }
            };
            let source = PathBuf::from(entry.source_path.trim());
            let metadata = match fs::metadata(&source) {
                Ok(value) if value.is_file() => value,
                _ => {
                    failed.push(WorkspaceImportFailure {
                        source_path: entry.source_path.clone(),
                        error: "源文件不存在或不可读取".into(),
                    });
                    continue;
                }
            };
            let target = match photo_target_relative(origin, &entry.target_relative) {
                Ok(value) => value,
                Err(error) => {
                    failed.push(WorkspaceImportFailure {
                        source_path: entry.source_path.clone(),
                        error,
                    });
                    continue;
                }
            };
            let id = sha1_hex(&format!("{volume_id}|{relative_source}"));
            let already_ready = manifest
                .photos
                .iter()
                .any(|photo| photo.id == id && photo.origin == origin && photo.status == "ready");
            if already_ready {
                skipped.push(id);
                continue;
            }
            let size_bytes = metadata.len();
            let mtime_ms = metadata.modified().map(system_time_ms).unwrap_or(0);
            let is_raw = crate::raw_decode::is_raw_path(&entry.source_path);
            // 缓存键由后端统一产出，前端只读取，避免两端各算一遍导致漂移。
            let cache_key = thumb_key(
                volume_id,
                &relative_source,
                size_bytes,
                mtime_ms,
                THUMBNAIL_MAX_SIDE,
            );
            let photo = WorkspacePhoto {
                id: id.clone(),
                volume_id: volume_id.to_string(),
                relative_source_path: relative_source,
                source_path: entry.source_path.clone(),
                origin: origin.to_string(),
                workspace_path: target.clone(),
                status: if origin == "copy" {
                    "pending".into()
                } else {
                    "ready".into()
                },
                size_bytes,
                mtime_ms,
                is_raw,
                width: None,
                height: None,
                thumb_key: Some(cache_key),
                stats: None,
                reference_override: None,
                develop: None,
                edited_at: None,
            };
            match manifest.photos.iter_mut().find(|photo| photo.id == id) {
                Some(existing) => {
                    // 重新登记（崩溃续传 / 失败重试）不得丢掉用户已有的调色参数。
                    let develop = existing.develop.take();
                    let stats = existing.stats.take();
                    let reference_override = existing.reference_override.take();
                    let edited_at = existing.edited_at;
                    *existing = photo;
                    existing.develop = develop;
                    existing.stats = stats;
                    existing.reference_override = reference_override;
                    existing.edited_at = edited_at;
                }
                None => manifest.photos.push(photo),
            }
            if origin == "copy" {
                if let Some(target_relative) = target {
                    planned.push((id.clone(), source, target_relative, size_bytes, mtime_ms));
                }
            }
            registered.push(id);
        }
        persist_manifest(&root, &mut manifest)?;
    }

    let total_bytes = planned.iter().map(|entry| entry.3).sum::<u64>();
    let total_files = u32::try_from(planned.len()).unwrap_or(u32::MAX);
    let mut copied_bytes = 0u64;
    let mut copied_files = 0u32;
    let mut cancelled = false;

    emit_import_progress(app, job_id, "copying", 0, total_bytes, 0, total_files, None);

    for (photo_id, source, target_relative, size_bytes, _mtime_ms) in planned {
        if flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let target = match safe_workspace_path(&root, &target_relative) {
            Ok(value) => value,
            Err(error) => {
                failed.push(WorkspaceImportFailure {
                    source_path: source.to_string_lossy().into_owned(),
                    error,
                });
                let _ = update_photo_status(&root, workspace_id, &photo_id, |photo| {
                    photo.status = "failed".into();
                });
                continue;
            }
        };
        match copy_file_streaming(
            app,
            job_id,
            &source,
            &target,
            &target_relative,
            &mut copied_bytes,
            total_bytes,
            copied_files,
            total_files,
        ) {
            Ok(()) => {
                let copied_size = fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
                if copied_size != size_bytes {
                    // 截断写入不得被当作完成
                    let _ = fs::remove_file(&target);
                    failed.push(WorkspaceImportFailure {
                        source_path: source.to_string_lossy().into_owned(),
                        error: format!("副本大小校验失败：期望 {size_bytes}，实际 {copied_size}"),
                    });
                    let _ = update_photo_status(&root, workspace_id, &photo_id, |photo| {
                        photo.status = "pending".into();
                    });
                    continue;
                }
                copied_files = copied_files.saturating_add(1);
                update_photo_status(&root, workspace_id, &photo_id, |photo| {
                    photo.status = "ready".into();
                    photo.workspace_path = Some(target_relative.clone());
                    photo.size_bytes = copied_size;
                })?;
                emit_import_progress(
                    app,
                    job_id,
                    "copying",
                    copied_bytes,
                    total_bytes,
                    copied_files,
                    total_files,
                    Some(target_relative),
                );
            }
            Err(error) => {
                // 半成品必须清理，否则会被误判为已完成
                let _ = fs::remove_file(&target);
                failed.push(WorkspaceImportFailure {
                    source_path: source.to_string_lossy().into_owned(),
                    error,
                });
                let _ = update_photo_status(&root, workspace_id, &photo_id, |photo| {
                    photo.status = "failed".into();
                });
            }
        }
    }

    if cancelled {
        emit_import_progress(
            app,
            job_id,
            "cancelled",
            copied_bytes,
            total_bytes,
            copied_files,
            total_files,
            None,
        );
    } else {
        emit_import_progress(
            app,
            job_id,
            "completed",
            copied_bytes,
            total_bytes,
            copied_files,
            total_files,
            None,
        );
    }

    let manifest = {
        let _guard = manifest_lock()
            .lock()
            .map_err(|_| "工作区正在写入，请稍候".to_string())?;
        load_manifest(&root, workspace_id)?
    };

    let imported = manifest
        .photos
        .iter()
        .filter(|photo| registered.contains(&photo.id))
        .cloned()
        .collect::<Vec<_>>();

    Ok(WorkspaceImportReport {
        manifest,
        imported,
        skipped,
        failed,
        copied_bytes,
        copied_files,
        cancelled,
    })
}

#[tauri::command]
pub async fn import_workspace_files(
    app: AppHandle,
    workspace_id: String,
    entries: Vec<WorkspaceImportEntry>,
    job_id: String,
) -> Result<WorkspaceImportReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_workspace_files_blocking(app, workspace_id, entries, job_id)
    })
    .await
    .map_err(|error| format!("工作区导入任务异常结束：{error}"))?
}

#[tauri::command]
pub fn cancel_workspace_import(job_id: String) -> Result<(), String> {
    let registry = cancellation_registry();
    let guard = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(job_id.trim()) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("没有正在进行的导入任务".into()),
    }
}

// ---------------------------------------------------------------------------
// 参考图登记（工作区级 / 单图专属覆盖）
// ---------------------------------------------------------------------------

fn import_workspace_reference_blocking(
    app: &AppHandle,
    workspace_id: &str,
    entry: WorkspaceImportEntry,
    photo_id: Option<String>,
) -> Result<WorkspaceManifest, String> {
    let root = ensure_workspace_dirs(app, workspace_id)?;
    let origin = entry.origin.trim();
    if origin != "copy" && origin != "reference" {
        return Err("导入来源类型无效".into());
    }
    let volume_id = entry.volume_id.trim();
    if volume_id.is_empty() {
        return Err("缺少卷标识，无法确认图片来源".into());
    }
    let relative_source = normalize_relative_path(&entry.relative_source_path)?;
    let source = PathBuf::from(entry.source_path.trim());
    let metadata =
        fs::metadata(&source).map_err(|error| format!("源文件不存在或不可读取：{error}"))?;
    if !metadata.is_file() {
        return Err("参考图必须是文件".into());
    }

    // 参考图走与普通原片同一条管线：复制到 references/，否则只登记源路径。
    let workspace_path = if origin == "copy" {
        let target_relative = reference_target_relative(&entry.target_relative)?;
        let target = safe_workspace_path(&root, &target_relative)?;
        let mut copied = 0u64;
        copy_file_streaming(
            app,
            "workspace-reference",
            &source,
            &target,
            &target_relative,
            &mut copied,
            metadata.len(),
            0,
            0,
        )?;
        Some(target_relative)
    } else {
        None
    };

    let reference = WorkspaceReference {
        id: format!(
            "ref_{}",
            sha1_hex(&format!("{volume_id}|{relative_source}"))
        ),
        origin: origin.to_string(),
        volume_id: volume_id.to_string(),
        relative_source_path: relative_source,
        source_path: entry.source_path.clone(),
        workspace_path,
        status: "ready".into(),
        stats: None,
    };

    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "工作区正在写入，请稍候".to_string())?;
    let mut manifest = load_manifest(&root, workspace_id)?;
    match photo_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => {
            let photo = manifest
                .photos
                .iter_mut()
                .find(|photo| photo.id == id)
                .ok_or_else(|| "工作区中找不到该图片".to_string())?;
            photo.reference_override = Some(reference);
        }
        None => {
            // 换参考图时回收旧副本，避免 references/ 无限增长。
            let previous = manifest
                .reference
                .as_ref()
                .and_then(|current| current.workspace_path.clone());
            if let Some(previous) = previous {
                if Some(previous.as_str()) != reference.workspace_path.as_deref() {
                    if let Ok(path) = safe_workspace_path(&root, &previous) {
                        let _ = fs::remove_file(path);
                    }
                }
            }
            manifest.reference = Some(reference);
        }
    }
    persist_manifest(&root, &mut manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub async fn import_workspace_reference(
    app: AppHandle,
    workspace_id: String,
    entry: WorkspaceImportEntry,
    photo_id: Option<String>,
) -> Result<WorkspaceManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_workspace_reference_blocking(&app, &workspace_id, entry, photo_id)
    })
    .await
    .map_err(|error| format!("参考图导入任务异常结束：{error}"))?
}

/// 解析参考图的真实读取路径。与普通原片走同一套语义：
/// copy 读工作区副本（源介质缺席仍可用），reference 读 `resolve_volume_mount` 得到的当前挂载点。
#[tauri::command]
pub fn resolve_workspace_reference_path(
    app: AppHandle,
    workspace_id: String,
    reference: WorkspaceReference,
) -> Result<Option<String>, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    if reference.origin == "copy" {
        let Some(relative) = reference.workspace_path else {
            return Ok(None);
        };
        let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        return Ok(path.is_file().then(|| path.to_string_lossy().into_owned()));
    }
    let Some(mount) = read_volume_mount_from_id(&reference.volume_id) else {
        return Ok(None);
    };
    let path = mount.join(
        reference
            .relative_source_path
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------------------
// manifest 保存（乐观并发）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn write_workspace_manifest(
    app: AppHandle,
    workspace_id: String,
    manifest: WorkspaceManifest,
    expected_revision: Option<u64>,
) -> Result<WorkspaceManifest, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let _guard = manifest_lock()
        .try_lock()
        .map_err(|_| "工作区正在导入，请稍候再保存".to_string())?;
    let current = load_manifest(&root, &workspace_id)?;
    if let Some(expected) = expected_revision {
        if current.revision != expected {
            return Err(format!(
                "工作区已在别处修改（期望 revision {expected}，实际 {}），已重新载入",
                current.revision
            ));
        }
    }
    let mut next = manifest;
    next.id = normalize_workspace_id(&workspace_id)?;
    if next.created_at == 0 {
        next.created_at = current.created_at;
    }
    next.revision = current.revision;
    normalize_manifest(&mut next, &workspace_id)?;
    // copy 条目的 ready 状态由磁盘事实决定，不接受前端直接声明。
    let (mut next, _changed) = recover_manifest(&root, next);
    persist_manifest(&root, &mut next)?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// 真实读取路径解析（含卷缺席判定）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedWorkspacePhoto {
    pub photo_id: String,
    pub path: Option<String>,
    pub status: String,
    /// 卷未挂载与文件已删除必须分开：前者提示连接设备，后者提示文件已被删除。
    pub reason: Option<String>,
    pub volume_mounted: bool,
}

fn resolve_photo(
    root: &Path,
    photo: &WorkspacePhoto,
    mounted_volumes: &mut HashMap<String, Option<PathBuf>>,
) -> ResolvedWorkspacePhoto {
    if photo.origin == "copy" {
        let Some(relative) = photo.workspace_path.clone() else {
            return ResolvedWorkspacePhoto {
                photo_id: photo.id.clone(),
                path: None,
                status: "pending".into(),
                reason: Some("副本尚未复制完成".into()),
                volume_mounted: true,
            };
        };
        let target = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if target.is_file() {
            ResolvedWorkspacePhoto {
                photo_id: photo.id.clone(),
                path: Some(target.to_string_lossy().into_owned()),
                status: "ready".into(),
                reason: None,
                volume_mounted: true,
            }
        } else {
            ResolvedWorkspacePhoto {
                photo_id: photo.id.clone(),
                path: None,
                status: "pending".into(),
                reason: Some("副本缺失，需要重新复制".into()),
                volume_mounted: true,
            }
        }
    } else {
        let mount = mounted_volumes
            .entry(photo.volume_id.clone())
            .or_insert_with(|| read_volume_mount_from_id(&photo.volume_id))
            .clone();
        match mount {
            Some(mount) => {
                let target = mount.join(
                    photo
                        .relative_source_path
                        .replace('/', std::path::MAIN_SEPARATOR_STR),
                );
                if target.is_file() {
                    ResolvedWorkspacePhoto {
                        photo_id: photo.id.clone(),
                        path: Some(target.to_string_lossy().into_owned()),
                        status: "ready".into(),
                        reason: None,
                        volume_mounted: true,
                    }
                } else {
                    ResolvedWorkspacePhoto {
                        photo_id: photo.id.clone(),
                        path: None,
                        status: "missing".into(),
                        reason: Some("文件已被删除".into()),
                        volume_mounted: true,
                    }
                }
            }
            None => ResolvedWorkspacePhoto {
                photo_id: photo.id.clone(),
                path: None,
                status: "missing".into(),
                reason: Some("请连接该设备".into()),
                volume_mounted: false,
            },
        }
    }
}

#[tauri::command]
pub fn resolve_workspace_photo_paths(
    app: AppHandle,
    workspace_id: String,
    photo_ids: Vec<String>,
) -> Result<Vec<ResolvedWorkspacePhoto>, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let manifest = load_manifest(&root, &workspace_id)?;
    let mut mounted_volumes: HashMap<String, Option<PathBuf>> = HashMap::new();
    let mut resolved = Vec::with_capacity(photo_ids.len());
    for photo_id in photo_ids {
        match manifest.photos.iter().find(|photo| photo.id == photo_id) {
            Some(photo) => resolved.push(resolve_photo(&root, photo, &mut mounted_volumes)),
            None => resolved.push(ResolvedWorkspacePhoto {
                photo_id,
                path: None,
                status: "missing".into(),
                reason: Some("图片已不在工作区".into()),
                volume_mounted: false,
            }),
        }
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// 卷缺席汇总
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceVolumeAbsence {
    pub volume_id: String,
    pub label: String,
    pub root_path: String,
    pub photo_count: u32,
}

#[tauri::command]
pub fn list_absent_workspace_volumes(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<WorkspaceVolumeAbsence>, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let manifest = load_manifest(&root, &workspace_id)?;
    let mut grouped: HashMap<String, (String, String, u32)> = HashMap::new();
    let mut mounted: HashMap<String, bool> = HashMap::new();
    for photo in &manifest.photos {
        if photo.origin != "reference" {
            continue;
        }
        let is_mounted = *mounted
            .entry(photo.volume_id.clone())
            .or_insert_with(|| read_volume_mount_from_id(&photo.volume_id).is_some());
        if is_mounted {
            continue;
        }
        let entry = grouped.entry(photo.volume_id.clone()).or_insert_with(|| {
            let root_path = Path::new(&photo.source_path)
                .components()
                .next()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .unwrap_or_else(|| photo.volume_id.clone());
            (photo.volume_id.clone(), root_path, 0)
        });
        entry.2 = entry.2.saturating_add(1);
    }
    let mut volumes = grouped
        .into_iter()
        .map(
            |(volume_id, (label, root_path, photo_count))| WorkspaceVolumeAbsence {
                volume_id,
                label,
                root_path,
                photo_count,
            },
        )
        .collect::<Vec<_>>();
    volumes.sort_by(|left, right| {
        left.root_path
            .to_ascii_lowercase()
            .cmp(&right.root_path.to_ascii_lowercase())
    });
    Ok(volumes)
}

// ---------------------------------------------------------------------------
// 缩略图缓存
// ---------------------------------------------------------------------------

fn normalize_thumb_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.len() < 8 || key.len() > 64 || !key.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("缩略图缓存键无效".into());
    }
    Ok(key.to_ascii_lowercase())
}

fn thumbs_root(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, String> {
    Ok(ensure_workspace_dirs(app, workspace_id)?.join("thumbs"))
}

#[tauri::command]
pub fn read_workspace_thumbnail(
    app: AppHandle,
    workspace_id: String,
    key: String,
) -> Result<Option<Vec<u8>>, String> {
    let key = normalize_thumb_key(&key)?;
    let path = thumbs_root(&app, &workspace_id)?.join(format!("{key}.jpg"));
    if !path.is_file() {
        return Ok(None);
    }
    fs::read(&path)
        .map(Some)
        .map_err(|error| format!("读取缩略图缓存失败：{error}"))
}

#[tauri::command]
pub fn write_workspace_thumbnail(
    app: AppHandle,
    workspace_id: String,
    key: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.is_empty() {
        return Err("缩略图内容为空".into());
    }
    if data.len() > 4 * 1024 * 1024 {
        return Err("缩略图内容过大".into());
    }
    let key = normalize_thumb_key(&key)?;
    let root = thumbs_root(&app, &workspace_id)?;
    let path = root.join(format!("{key}.jpg"));
    let temporary = root.join(format!("{key}.jpg.tmp"));
    fs::write(&temporary, &data).map_err(|error| format!("无法写入缩略图缓存：{error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法启用缩略图缓存：{error}"))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCacheReport {
    pub removed_files: u32,
    pub freed_bytes: u64,
}

fn directory_usage(path: &Path) -> (u32, u64) {
    let mut files = 0u32;
    let mut bytes = 0u64;
    let Ok(entries) = fs::read_dir(path) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            let (nested_files, nested_bytes) = directory_usage(&entry.path());
            files = files.saturating_add(nested_files);
            bytes = bytes.saturating_add(nested_bytes);
        } else if metadata.is_file() {
            files = files.saturating_add(1);
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    (files, bytes)
}

/// 整体删除缩略图缓存：可无损重建，因此无需逐张清理。
#[tauri::command]
pub fn purge_workspace_thumbnails(
    app: AppHandle,
    workspace_id: String,
) -> Result<WorkspaceCacheReport, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let thumbs = root.join("thumbs");
    let (removed_files, freed_bytes) = directory_usage(&thumbs);
    if thumbs.exists() {
        fs::remove_dir_all(&thumbs).map_err(|error| format!("无法清空缩略图缓存：{error}"))?;
    }
    fs::create_dir_all(&thumbs).map_err(|error| format!("无法重建缩略图缓存目录：{error}"))?;
    Ok(WorkspaceCacheReport {
        removed_files,
        freed_bytes,
    })
}

/// 清空工作区：删除 manifest 条目与 originals/、references/、thumbs/ 下的全部副本。
#[tauri::command]
pub fn clear_workspace(
    app: AppHandle,
    workspace_id: String,
) -> Result<WorkspaceCacheReport, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let _guard = manifest_lock()
        .try_lock()
        .map_err(|_| "工作区正在导入，请稍候再清空".to_string())?;

    let mut removed_files = 0u32;
    let mut freed_bytes = 0u64;
    for name in ["originals", "references", "thumbs"] {
        let path = root.join(name);
        let (files, bytes) = directory_usage(&path);
        removed_files = removed_files.saturating_add(files);
        freed_bytes = freed_bytes.saturating_add(bytes);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|error| format!("无法清理工作区副本：{error}"))?;
        }
        fs::create_dir_all(&path).map_err(|error| format!("无法重建工作区目录：{error}"))?;
    }

    let mut manifest = default_manifest(&workspace_id)?;
    manifest.created_at = now_ms();
    persist_manifest(&root, &mut manifest)?;
    Ok(WorkspaceCacheReport {
        removed_files,
        freed_bytes,
    })
}

// ---------------------------------------------------------------------------
// 磁盘空间与文件夹
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn free_space(path: &Path) -> Option<(u64, u64)> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let text = windows_wide(path);
    let mut available = 0u64;
    let mut total = 0u64;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(text.as_ptr()),
            Some(&mut available),
            Some(&mut total),
            None,
        )
        .ok()?;
    }
    Some((available, total))
}

#[cfg(not(target_os = "windows"))]
fn free_space(path: &Path) -> Option<(u64, u64)> {
    let output = Command::new("df").arg("-k").arg(path).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().nth(1)?;
    let mut parts = line.split_whitespace();
    let total_kb: u64 = parts.next()?.parse().ok()?;
    let _used_kb: u64 = parts.next()?.parse().ok()?;
    let available_kb: u64 = parts.next()?.parse().ok()?;
    Some((
        available_kb.saturating_mul(1024),
        total_kb.saturating_mul(1024),
    ))
}

/// 空间预检：按实际字节数返回复制目标盘的可用与总容量。
#[tauri::command]
pub fn workspace_disk_space(
    app: AppHandle,
    workspace_id: String,
) -> Result<WorkspaceDiskSpace, String> {
    let root = ensure_workspace_dirs(&app, &workspace_id)?;
    let (available_bytes, total_bytes) = free_space(&root).unwrap_or((0, 0));
    Ok(WorkspaceDiskSpace {
        path: root.to_string_lossy().into_owned(),
        available_bytes,
        total_bytes,
    })
}

#[tauri::command]
pub fn open_workspace_folder(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let path = ensure_workspace_dirs(&app, &workspace_id)?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("explorer.exe")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法在文件资源管理器中打开工作区：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法在访达中打开工作区：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开工作区文件夹：{error}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 图片属性 / 定位 / 删除（工作区内容页的右键菜单）
//
// 放在这里而不是新模块：新模块拿不到 `ensure_workspace_dirs` / `load_manifest` /
// `manifest_lock`，只能各复制一份，「哪里算工作区内」「谁持有 manifest 锁」这两条
// 规则就会写成两遍。EXIF 解析与命令外壳在 `crate::photo_info`。
// ---------------------------------------------------------------------------

/// 属性 / 定位命令的上下文：manifest 条目 + 真实读取路径。
pub(crate) struct WorkspacePhotoContext {
    pub photo: WorkspacePhoto,
    pub resolved: ResolvedWorkspacePhoto,
}

/// 按 photoId 取上下文。图片已不在 manifest 时给出明确文案，而不是返回空结构。
pub(crate) fn workspace_photo_context(
    app: &AppHandle,
    workspace_id: &str,
    photo_id: &str,
) -> Result<WorkspacePhotoContext, String> {
    let root = ensure_workspace_dirs(app, workspace_id)?;
    let manifest = load_manifest(&root, workspace_id)?;
    let photo = manifest
        .photos
        .into_iter()
        .find(|photo| photo.id == photo_id)
        .ok_or_else(|| "图片已不在工作区".to_string())?;
    let resolved = resolve_photo(&root, &photo, &mut HashMap::new());
    Ok(WorkspacePhotoContext { photo, resolved })
}

/// 从工作区移除若干图片的结果：新的 manifest 与回收账。
pub(crate) struct RemovedWorkspacePhotos {
    pub manifest: WorkspaceManifest,
    pub removed_photo_ids: Vec<String>,
    pub removed_files: u32,
    pub freed_bytes: u64,
}

/// 从工作区移除若干图片。
///
/// 只动三类东西：manifest 条目、`originals/` 下本应用自己的副本、`thumbs/` 下对应的缓存。
/// **绝不删除源文件**——同一张原片可能被多个工作区引用（photoId 跨工作区同值），
/// 也可能根本不在本机（卷未挂载）。删用户照片是资料管理器的事，不是工作区的事。
pub(crate) fn remove_workspace_photos(
    app: &AppHandle,
    workspace_id: &str,
    photo_ids: &[String],
) -> Result<RemovedWorkspacePhotos, String> {
    let wanted: HashSet<&str> = photo_ids.iter().map(String::as_str).collect();
    if wanted.is_empty() {
        return Err("没有选中任何图片".into());
    }
    let root = ensure_workspace_dirs(app, workspace_id)?;
    // 与导入互斥：导入过程中 manifest 会被反复重写，此时删除会两边互相覆盖。
    let _guard = manifest_lock()
        .try_lock()
        .map_err(|_| "工作区正在导入，请稍候再删除".to_string())?;

    let mut manifest = load_manifest(&root, workspace_id)?;
    let targets = manifest
        .photos
        .iter()
        .filter(|photo| wanted.contains(photo.id.as_str()))
        .map(|photo| {
            let mut paths = Vec::new();
            // safe_workspace_path 会把越界路径判为错误；损坏的 manifest 不能变成「删任意文件」。
            let mut push_workspace_copy = |relative: Option<&str>| {
                if let Some(path) =
                    relative.and_then(|value| safe_workspace_path(&root, value).ok())
                {
                    paths.push(path);
                }
            };
            push_workspace_copy(photo.workspace_path.as_deref());
            // 单图专属参考图也是工作区里的一份副本：整夹清理时代它被顺手删掉，
            // 逐张删除必须显式回收，否则它会永远留在 references/ 里。
            push_workspace_copy(
                photo
                    .reference_override
                    .as_ref()
                    .and_then(|entry| entry.workspace_path.as_deref()),
            );
            if let Some(key) = photo
                .thumb_key
                .as_deref()
                .and_then(|key| normalize_thumb_key(key).ok())
            {
                paths.push(root.join("thumbs").join(format!("{key}.jpg")));
            }
            (photo.id.clone(), paths)
        })
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Err("这些图片已不在工作区".into());
    }

    // 先落盘 manifest，再删文件。
    //
    // 顺序反过来时，删到一半失败（或 persist 被别的写入打断）会留下「磁盘副本没了、
    // manifest 还记着它」的坏状态；反过来最多留下几个孤儿副本，下次导入或清空工作区
    // 会顺手覆盖/回收它们。manifest 是唯一真相源，就先让它说真话。
    manifest
        .photos
        .retain(|photo| !wanted.contains(photo.id.as_str()));
    // persist_manifest 内部做 revision 自增，删除因此同样参与乐观并发。
    persist_manifest(&root, &mut manifest)?;

    let mut removed_files = 0u32;
    let mut freed_bytes = 0u64;
    for (_, paths) in &targets {
        for path in paths {
            let (files, bytes) = remove_file_if_present(path);
            removed_files = removed_files.saturating_add(files);
            freed_bytes = freed_bytes.saturating_add(bytes);
        }
    }

    Ok(RemovedWorkspacePhotos {
        manifest,
        removed_photo_ids: targets.into_iter().map(|(photo_id, _)| photo_id).collect(),
        removed_files,
        freed_bytes,
    })
}

/// 删除单个文件并回报「删了几个 / 回收多少字节」；文件不存在视为 0，不报错。
fn remove_file_if_present(path: &Path) -> (u32, u64) {
    let Ok(metadata) = fs::metadata(path) else {
        return (0, 0);
    };
    if !metadata.is_file() {
        return (0, 0);
    }
    match fs::remove_file(path) {
        Ok(()) => (1, metadata.len()),
        Err(error) => {
            log::warn!("删除工作区副本失败：{error}");
            (0, 0)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::{
        normalize_relative_path, normalize_thumb_key, normalize_workspace_id,
        parse_volume_policies, photo_target_relative, recommendation_for_drive_type,
        recover_manifest, reference_target_relative, resolve_photo, thumb_key, validate_manifest,
        WorkspaceManifest, WorkspacePhoto,
    };
    use std::collections::HashMap;
    use std::path::Path;

    fn photo(id: &str, origin: &str, workspace_path: Option<&str>, size: u64) -> WorkspacePhoto {
        WorkspacePhoto {
            id: id.into(),
            volume_id: "VOL1".into(),
            relative_source_path: "2024/a.cr3".into(),
            source_path: "E:/2024/a.cr3".into(),
            origin: origin.into(),
            workspace_path: workspace_path.map(str::to_string),
            status: "ready".into(),
            size_bytes: size,
            mtime_ms: 1,
            is_raw: true,
            width: None,
            height: None,
            thumb_key: None,
            stats: None,
            reference_override: None,
            develop: None,
            edited_at: None,
        }
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(normalize_relative_path("../etc/passwd").is_err());
        assert!(normalize_relative_path("/abs/path.cr3").is_err());
        assert!(normalize_relative_path("C:/abs/path.cr3").is_err());
        assert!(normalize_relative_path("a/b/../../c.cr3").is_err());
        assert!(normalize_relative_path("   ").is_err());
    }

    #[test]
    fn normalizes_windows_separators() {
        let separator = char::from(92u8);
        let input = format!("2024{separator}Wedding{separator}IMG_0001.CR3");
        assert_eq!(
            normalize_relative_path(&input).unwrap(),
            "2024/Wedding/IMG_0001.CR3"
        );
    }

    #[test]
    fn limits_folder_depth() {
        let deep = vec!["d"; 12].join("/") + "/a.cr3";
        assert!(normalize_relative_path(&deep).is_err());
    }

    #[test]
    fn rejects_invalid_workspace_ids() {
        assert!(normalize_workspace_id("default").is_ok());
        assert!(normalize_workspace_id("..").is_err());
        assert!(normalize_workspace_id("a/b").is_err());
        assert!(normalize_workspace_id("").is_err());
    }

    #[test]
    fn volume_policy_file_reads_both_shapes() {
        // 旧的平铺形态（裸字符串）必须继续可读，否则升级后用户记忆会整体丢失
        let legacy = br#"{"1A2B-3C4D":"copy","X":"reference"}"#;
        let parsed = parse_volume_policies(legacy);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed["1A2B-3C4D"].policy, "copy");
        assert_eq!(parsed["1A2B-3C4D"].label, "");

        let current = br#"{"1A2B-3C4D":{"policy":"reference","label":"MyPassport","updatedAt":7}}"#;
        let parsed = parse_volume_policies(current);
        assert_eq!(parsed["1A2B-3C4D"].policy, "reference");
        assert_eq!(parsed["1A2B-3C4D"].label, "MyPassport");
        assert_eq!(parsed["1A2B-3C4D"].updated_at, 7);

        // 非法策略值被丢弃，而不是带着脏数据进入判定
        let dirty = br#"{"BAD":"delete","ALSO_BAD":5}"#;
        assert!(parse_volume_policies(dirty).is_empty());
    }

    #[test]
    fn copy_entries_target_originals_only() {
        assert_eq!(
            photo_target_relative("copy", "2024/a.cr3").unwrap(),
            Some("originals/2024/a.cr3".to_string())
        );
        // 引用模式不产生副本
        assert_eq!(
            photo_target_relative("reference", "2024/a.cr3").unwrap(),
            None
        );
        assert!(photo_target_relative("copy", "references/a.jpg").is_err());
    }

    #[test]
    fn reference_targets_use_references_root() {
        assert_eq!(
            reference_target_relative("look.jpg").unwrap(),
            "references/look.jpg"
        );
        assert_eq!(
            reference_target_relative("references/look.jpg").unwrap(),
            "references/look.jpg"
        );
        assert!(reference_target_relative("../look.jpg").is_err());
    }

    #[test]
    fn unknown_drive_types_default_to_copy() {
        assert_eq!(recommendation_for_drive_type("fixed"), "reference");
        assert_eq!(recommendation_for_drive_type("removable"), "copy");
        assert_eq!(recommendation_for_drive_type("remote"), "copy");
        assert_eq!(recommendation_for_drive_type("cdrom"), "copy");
        assert_eq!(recommendation_for_drive_type("ramdisk"), "copy");
        assert_eq!(recommendation_for_drive_type("unknown"), "copy");
    }

    #[test]
    fn thumb_key_tracks_identity_and_file_state() {
        let base = thumb_key("VOL1", "2024/a.cr3", 100, 200, 256);
        assert_eq!(base, thumb_key("VOL1", "2024/a.cr3", 100, 200, 256));
        assert_ne!(base, thumb_key("VOL2", "2024/a.cr3", 100, 200, 256));
        assert_ne!(base, thumb_key("VOL1", "2024/a.cr3", 101, 200, 256));
        assert_ne!(base, thumb_key("VOL1", "2024/a.cr3", 100, 201, 256));
        assert_ne!(base, thumb_key("VOL1", "2024/a.cr3", 100, 200, 512));
        // 卷内相对路径大小写归一：同一张图不应产生两份缓存
        assert_eq!(base, thumb_key("VOL1", "2024/A.CR3", 100, 200, 256));
        // 与前端 `src/lib/hash.test.ts` 钉的是同一个摘要，两端必须一致
        assert_eq!(base, "b7eb3773a291d59c2e019ea1bdb55866ad24f406");
    }

    #[test]
    fn thumb_cache_keys_must_be_hex() {
        assert!(normalize_thumb_key("A1B2C3D4").is_ok());
        assert!(normalize_thumb_key("../../escape").is_err());
        assert!(normalize_thumb_key("short").is_err());
    }

    #[test]
    fn recovery_downgrades_missing_or_truncated_copies() {
        let root = Path::new("__missing_root__");
        let mut manifest = WorkspaceManifest::default();
        manifest.photos = vec![
            photo("a", "copy", Some("originals/2024/a.cr3"), 10),
            photo("b", "copy", None, 10),
            photo("c", "reference", None, 10),
        ];
        let (recovered, changed) = recover_manifest(root, manifest);
        assert!(changed);
        assert_eq!(recovered.photos[0].status, "pending");
        assert_eq!(recovered.photos[1].status, "pending");
        // 引用模式没有副本，不应被复制语义降级
        assert_eq!(recovered.photos[2].status, "ready");
    }

    #[test]
    fn manifest_validation_enforces_origin_directory_match() {
        let mut manifest = WorkspaceManifest::default();
        manifest.photos = vec![photo("a", "copy", Some("references/a.jpg"), 10)];
        assert!(validate_manifest(&manifest).is_err());

        let mut manifest = WorkspaceManifest::default();
        manifest.photos = vec![photo("a", "reference", Some("references/a.jpg"), 10)];
        assert!(validate_manifest(&manifest).is_ok());
    }

    #[test]
    fn missing_reference_reports_device_or_deletion_separately() {
        let root = Path::new("__missing_root__");
        let mut mounted = HashMap::new();
        // 卷未挂载：提示连接设备
        let absent = resolve_photo(root, &photo("a", "reference", None, 10), &mut mounted);
        assert_eq!(absent.status, "missing");
        assert_eq!(absent.volume_mounted, false);
        assert!(absent.reason.unwrap().contains("设备"));
    }
}
