//! Local XMP / CUBE asset library under the app data directory.
//!
//! Layout (folder hierarchy preserved):
//!   {app_data}/library/xmp/**/*.xmp
//!   {app_data}/library/cube/**/*.cube
//!
//! Asset identity is the relative path under the kind root (POSIX-style `/`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager};

const MAX_FOLDER_DEPTH: usize = 8;
const MAX_FOLDER_FILES: usize = 2000;
const LIBRARY_LOCATION_FILE: &str = "library-location.json";
const MIGRATION_EVENT: &str = "library-migration-progress";
static LIBRARY_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLocation {
    pub path: String,
    pub is_custom: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryLocationConfig {
    path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMigrationProgress {
    pub migration_id: String,
    pub phase: String,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub copied_files: u32,
    pub total_files: u32,
    pub percent: f64,
    pub current_file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMigrationResult {
    pub path: String,
    pub copied_bytes: u64,
    pub copied_files: u32,
    pub cleanup_warning: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetKind {
    Xmp,
    Cube,
}

impl AssetKind {
    fn from_str(value: &str) -> Result<Self, String> {
        match value.to_ascii_lowercase().as_str() {
            "xmp" => Ok(Self::Xmp),
            "cube" => Ok(Self::Cube),
            _ => Err(format!("未知资产类型：{value}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Xmp => "xmp",
            Self::Cube => "cube",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Xmp => "xmp",
            Self::Cube => "cube",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Xmp => 2 * 1024 * 1024,
            Self::Cube => 48 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAsset {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub file_name: String,
    pub relative_path: String,
    pub folder: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub lut_size: Option<u32>,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))
}

fn default_library_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("library"))
}

fn library_location_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(LIBRARY_LOCATION_FILE))
}

fn configured_library_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let config_path = library_location_config_path(app)?;
    if !config_path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&config_path)
        .map_err(|error| format!("无法读取资料库位置配置：{error}"))?;
    let config: LibraryLocationConfig =
        serde_json::from_str(&text).map_err(|error| format!("资料库位置配置无效：{error}"))?;
    let path = PathBuf::from(config.path.trim());
    if !path.is_absolute() {
        return Err("资料库位置必须是绝对路径".into());
    }
    Ok(Some(path))
}

pub(crate) fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(configured_library_root(app)?.unwrap_or(default_library_root(app)?))
}

fn write_library_location(app: &AppHandle, path: &Path) -> Result<(), String> {
    let config_path = library_location_config_path(app)?;
    let parent = config_path
        .parent()
        .ok_or_else(|| "资料库位置配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let config = LibraryLocationConfig {
        path: path.to_string_lossy().into_owned(),
    };
    let data = serde_json::to_vec_pretty(&config)
        .map_err(|error| format!("无法序列化资料库位置：{error}"))?;
    let temporary = config_path.with_extension("json.tmp");
    fs::write(&temporary, data).map_err(|error| format!("无法保存资料库位置：{error}"))?;
    #[cfg(target_os = "windows")]
    if config_path.exists() {
        let backup = config_path.with_extension("json.bak");
        let _ = fs::remove_file(&backup);
        fs::rename(&config_path, &backup)
            .map_err(|error| format!("无法备份原资料库位置配置：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &config_path) {
            let _ = fs::rename(&backup, &config_path);
            return Err(format!("无法启用新资料库位置：{error}"));
        }
        let _ = fs::remove_file(&backup);
        return Ok(());
    }
    fs::rename(&temporary, &config_path).map_err(|error| format!("无法启用新资料库位置：{error}"))
}

fn kind_dir(app: &AppHandle, kind: AssetKind) -> Result<PathBuf, String> {
    let path = library_root(app)?.join(kind.as_str());
    fs::create_dir_all(&path).map_err(|error| format!("无法创建资料库目录：{error}"))?;
    Ok(path)
}

fn system_time_ms(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_segment(segment: &str) -> String {
    let cleaned: String = segment
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "item".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Normalize a relative path: strip leading slashes, reject `..`, sanitize segments.
pub(crate) fn normalize_relative_path(raw: &str, kind: AssetKind) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    for part in raw.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("相对路径不能包含上级目录".into());
        }
        parts.push(sanitize_segment(part));
    }
    if parts.is_empty() {
        return Err("相对路径无效".into());
    }
    if parts.len() > MAX_FOLDER_DEPTH + 1 {
        return Err(format!("文件夹层级不能超过 {MAX_FOLDER_DEPTH} 层"));
    }

    let last = parts.last().cloned().unwrap_or_else(|| "asset".into());
    let lower = last.to_ascii_lowercase();
    let ext = format!(".{}", kind.extension());
    let file_name = if lower.ends_with(&ext) {
        last
    } else {
        format!("{last}{ext}")
    };
    let last_index = parts.len() - 1;
    parts[last_index] = file_name;
    Ok(parts.join("/"))
}

fn folder_of(relative_path: &str) -> String {
    match relative_path.rsplit_once('/') {
        Some((folder, _)) => folder.to_string(),
        None => String::new(),
    }
}

fn basename_of(relative_path: &str) -> String {
    relative_path
        .rsplit_once('/')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| relative_path.to_string())
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in relative.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        path.push(part);
    }
    path
}

fn unique_relative_path(root: &Path, relative: &str) -> Result<String, String> {
    let candidate = join_relative(root, relative);
    if !candidate.exists() {
        return Ok(relative.to_string());
    }

    let folder = folder_of(relative);
    let file_name = basename_of(relative);
    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for index in 2..10_000 {
        let next_name = if ext.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{ext}")
        };
        let next_rel = if folder.is_empty() {
            next_name
        } else {
            format!("{folder}/{next_name}")
        };
        if !join_relative(root, &next_rel).exists() {
            return Ok(next_rel);
        }
    }
    Err("无法生成唯一文件名".into())
}

fn cube_lut_size(path: &Path) -> Option<u32> {
    const HEADER_LIMIT: u64 = 64 * 1024;
    let mut bytes = Vec::with_capacity(4096);
    fs::File::open(path)
        .ok()?
        .take(HEADER_LIMIT)
        .read_to_end(&mut bytes)
        .ok()?;
    let header = String::from_utf8_lossy(&bytes);
    for raw_line in header.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let mut parts = line.split_whitespace();
        if !parts
            .next()
            .is_some_and(|keyword| keyword.eq_ignore_ascii_case("LUT_3D_SIZE"))
        {
            continue;
        }
        return parts.next()?.parse::<u32>().ok().filter(|size| *size >= 2);
    }
    None
}

fn asset_from_file(
    kind: AssetKind,
    root: &Path,
    absolute: &Path,
    relative: &str,
) -> Option<LibraryAsset> {
    let meta = fs::metadata(absolute).ok()?;
    if !meta.is_file() {
        return None;
    }
    let file_name = basename_of(relative);
    let name = Path::new(&file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(&file_name)
        .to_string();
    // Ensure the absolute path is under root (string compare, Windows-safe).
    let strip_unc = |value: &str| {
        let normalized = value.replace('/', "\\");
        normalized
            .strip_prefix(r"\\?\")
            .unwrap_or(&normalized)
            .to_ascii_lowercase()
    };
    let root_key = strip_unc(&root.to_string_lossy());
    let abs_key = strip_unc(&absolute.to_string_lossy());
    if !abs_key.starts_with(&root_key) {
        return None;
    }
    Some(LibraryAsset {
        id: format!("{}:{}", kind.as_str(), relative),
        kind: kind.as_str().to_string(),
        name,
        file_name,
        relative_path: relative.to_string(),
        folder: folder_of(relative),
        size_bytes: meta.len(),
        modified_ms: meta.modified().map(system_time_ms).unwrap_or(0),
        lut_size: if kind == AssetKind::Cube {
            cube_lut_size(absolute)
        } else {
            None
        },
    })
}

fn matches_extension(path: &Path, kind: AssetKind) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case(kind.extension()))
        .unwrap_or(false)
}

fn collect_files(
    dir: &Path,
    kind: AssetKind,
    out: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_FOLDER_DEPTH {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("skip unreadable dir {:?}: {error}", dir);
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Follow neither symlinks aggressively; treat as dir/file via metadata.
        let meta = match fs::metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_files(&path, kind, out, depth + 1)?;
        } else if meta.is_file() && matches_extension(&path, kind) {
            out.push(path);
        }
        if out.len() > MAX_FOLDER_FILES {
            return Err(format!(
                "单次导入超过 {MAX_FOLDER_FILES} 个文件，请缩小范围"
            ));
        }
    }
    Ok(())
}

fn walk_library(
    root: &Path,
    kind: AssetKind,
    relative_prefix: &str,
    out: &mut Vec<LibraryAsset>,
    depth: usize,
) {
    if depth > MAX_FOLDER_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("folder");
            let next = if relative_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{relative_prefix}/{name}")
            };
            walk_library(&path, kind, &next, out, depth + 1);
        } else if meta.is_file() && matches_extension(&path, kind) {
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("asset");
            let relative = if relative_prefix.is_empty() {
                file_name.to_string()
            } else {
                format!("{relative_prefix}/{file_name}")
            };
            if let Some(asset) = asset_from_file(kind, root, &path, &relative) {
                out.push(asset);
            }
        }
    }
}

/// Build a portable relative path from folder -> file without requiring identical path prefixes.
fn relative_from_base(base: &Path, file: &Path) -> Result<String, String> {
    // Prefer strip_prefix when both share the same representation.
    if let Ok(rel) = file.strip_prefix(base) {
        return components_to_relative(rel);
    }

    // Fallback: canonicalize both (handles trailing separators / mixed separators on Windows).
    let base_canon = fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let file_canon =
        fs::canonicalize(file).map_err(|error| format!("无法解析文件路径：{error}"))?;
    let rel = file_canon
        .strip_prefix(&base_canon)
        .map_err(|_| format!("文件不在所选文件夹内：{}", file.display()))?;
    components_to_relative(rel)
}

fn components_to_relative(rel: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => {
                let text = part
                    .to_str()
                    .ok_or_else(|| "路径包含无效字符".to_string())?;
                parts.push(sanitize_segment(text));
            }
            Component::CurDir => {}
            _ => return Err("相对路径非法".into()),
        }
    }
    if parts.is_empty() {
        return Err("相对路径无效".into());
    }
    Ok(parts.join("/"))
}

fn copy_into_library(
    root: &Path,
    kind: AssetKind,
    source: &Path,
    relative: &str,
) -> Result<LibraryAsset, String> {
    let normalized = normalize_relative_path(relative, kind)?;
    let unique = unique_relative_path(root, &normalized)?;
    let target = join_relative(root, &unique);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建子文件夹失败：{error}"))?;
    }
    fs::copy(source, &target).map_err(|error| {
        format!(
            "复制失败（{} → {}）：{error}",
            source.display(),
            target.display()
        )
    })?;
    asset_from_file(kind, root, &target, &unique)
        .ok_or_else(|| format!("导入后无法读取：{}", target.display()))
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
    let mut parent = path_key(parent);
    while parent.ends_with('/') {
        parent.pop();
    }
    path == parent || path.starts_with(&format!("{parent}/"))
}

fn collect_migration_entries(
    root: &Path,
    current: &Path,
    directories: &mut Vec<PathBuf>,
    files: &mut Vec<(PathBuf, u64)>,
) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("无法扫描资料库目录 {}：{error}", current.display()))?
    {
        let entry = entry.map_err(|error| format!("无法读取资料库条目：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取资料库条目类型 {}：{error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "资料库包含不支持迁移的符号链接：{}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| format!("资料库条目路径无效：{}", path.display()))?
            .to_path_buf();
        if file_type.is_dir() {
            directories.push(relative);
            collect_migration_entries(root, &path, directories, files)?;
        } else if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|error| format!("无法读取文件信息 {}：{error}", path.display()))?
                .len();
            files.push((relative, size));
        }
    }
    Ok(())
}

fn emit_migration_progress(
    app: &AppHandle,
    migration_id: &str,
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
        MIGRATION_EVENT,
        LibraryMigrationProgress {
            migration_id: migration_id.to_string(),
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

fn copy_file_with_progress(
    app: &AppHandle,
    migration_id: &str,
    source: &Path,
    target: &Path,
    display_path: &str,
    copied_bytes: &mut u64,
    total_bytes: u64,
    copied_files: u32,
    total_files: u32,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目标文件夹 {}：{error}", parent.display()))?;
    }
    let mut reader = fs::File::open(source)
        .map_err(|error| format!("无法读取资料库文件 {}：{error}", source.display()))?;
    let mut writer = fs::File::create(target)
        .map_err(|error| format!("无法创建目标文件 {}：{error}", target.display()))?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取资料库文件失败 {}：{error}", source.display()))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入目标文件失败 {}：{error}", target.display()))?;
        *copied_bytes = copied_bytes.saturating_add(read as u64);
        emit_migration_progress(
            app,
            migration_id,
            "copying",
            *copied_bytes,
            total_bytes,
            copied_files,
            total_files,
            Some(display_path.to_string()),
        );
    }
    writer
        .sync_all()
        .map_err(|error| format!("无法完成目标文件写入 {}：{error}", target.display()))?;
    if let Ok(metadata) = fs::metadata(source) {
        let _ = fs::set_permissions(target, metadata.permissions());
    }
    Ok(())
}

fn migrate_library_blocking(
    app: AppHandle,
    destination_path: String,
    migration_id: String,
) -> Result<LibraryMigrationResult, String> {
    let lock = LIBRARY_MIGRATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .try_lock()
        .map_err(|_| "已有资料库迁移任务正在进行，请稍候".to_string())?;

    let source = library_root(&app)?;
    fs::create_dir_all(&source).map_err(|error| format!("无法访问当前资料库：{error}"))?;
    let source =
        fs::canonicalize(&source).map_err(|error| format!("无法解析当前资料库路径：{error}"))?;

    let destination_text = destination_path.trim();
    if destination_text.is_empty() {
        return Err("请选择新的资料库文件夹".into());
    }
    let destination = PathBuf::from(destination_text);
    if !destination.is_absolute() {
        return Err("新的资料库位置必须是绝对路径".into());
    }
    fs::create_dir_all(&destination)
        .map_err(|error| format!("无法创建新的资料库文件夹：{error}"))?;
    let destination = fs::canonicalize(&destination)
        .map_err(|error| format!("无法解析新的资料库路径：{error}"))?;

    if path_is_within(&destination, &source) || path_is_within(&source, &destination) {
        return Err("新旧资料库路径不能相同，也不能互为父子文件夹".into());
    }
    let mut existing =
        fs::read_dir(&destination).map_err(|error| format!("无法检查新的资料库文件夹：{error}"))?;
    if existing.next().is_some() {
        return Err("新的资料库文件夹必须为空，请选择或新建一个空文件夹".into());
    }

    emit_migration_progress(&app, &migration_id, "scanning", 0, 0, 0, 0, None);
    let mut directories = Vec::new();
    let mut files = Vec::new();
    collect_migration_entries(&source, &source, &mut directories, &mut files)?;
    let total_bytes = files.iter().map(|(_, size)| *size).sum::<u64>();
    let total_files = u32::try_from(files.len()).unwrap_or(u32::MAX);
    emit_migration_progress(
        &app,
        &migration_id,
        "copying",
        0,
        total_bytes,
        0,
        total_files,
        None,
    );

    let staging = destination.join(format!(".chromatrace-migration-{migration_id}"));
    fs::create_dir(&staging).map_err(|error| format!("无法创建迁移暂存目录：{error}"))?;
    let migration_result = (|| -> Result<(u64, u32), String> {
        for relative in &directories {
            fs::create_dir_all(staging.join(relative))
                .map_err(|error| format!("无法创建目标子文件夹 {}：{error}", relative.display()))?;
        }
        let mut copied_bytes = 0u64;
        let mut copied_files = 0u32;
        for (relative, _) in &files {
            let display_path = relative.to_string_lossy().replace('\\', "/");
            copy_file_with_progress(
                &app,
                &migration_id,
                &source.join(relative),
                &staging.join(relative),
                &display_path,
                &mut copied_bytes,
                total_bytes,
                copied_files,
                total_files,
            )?;
            copied_files = copied_files.saturating_add(1);
            emit_migration_progress(
                &app,
                &migration_id,
                "copying",
                copied_bytes,
                total_bytes,
                copied_files,
                total_files,
                Some(display_path),
            );
        }

        emit_migration_progress(
            &app,
            &migration_id,
            "finalizing",
            copied_bytes,
            total_bytes,
            copied_files,
            total_files,
            None,
        );
        let staged_entries =
            fs::read_dir(&staging).map_err(|error| format!("无法读取迁移暂存目录：{error}"))?;
        for entry in staged_entries {
            let entry = entry.map_err(|error| format!("无法读取迁移暂存条目：{error}"))?;
            let target = destination.join(entry.file_name());
            fs::rename(entry.path(), &target)
                .map_err(|error| format!("无法启用迁移文件 {}：{error}", target.display()))?;
        }
        fs::remove_dir(&staging).map_err(|error| format!("无法清理迁移暂存目录：{error}"))?;
        write_library_location(&app, &destination)?;
        Ok((copied_bytes, copied_files))
    })();

    let (copied_bytes, copied_files) = match migration_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            if let Ok(entries) = fs::read_dir(&destination) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let _ = fs::remove_dir_all(path);
                    } else {
                        let _ = fs::remove_file(path);
                    }
                }
            }
            return Err(error);
        }
    };

    let cleanup_warning = if source.exists() {
        match fs::remove_dir_all(&source) {
            Ok(()) => None,
            Err(error) => Some(format!(
                "新资料库已启用，但旧资料库未能自动删除（{}）：{error}",
                source.display()
            )),
        }
    } else {
        None
    };
    emit_migration_progress(
        &app,
        &migration_id,
        "completed",
        copied_bytes,
        total_bytes,
        copied_files,
        total_files,
        None,
    );
    Ok(LibraryMigrationResult {
        path: destination.to_string_lossy().into_owned(),
        copied_bytes,
        copied_files,
        cleanup_warning,
    })
}

#[tauri::command]
pub fn get_library_location(app: AppHandle) -> Result<LibraryLocation, String> {
    let path = library_root(&app)?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建资料库目录：{error}"))?;
    let default = default_library_root(&app)?;
    Ok(LibraryLocation {
        is_custom: path_key(&path) != path_key(&default),
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn open_library_folder(app: AppHandle) -> Result<(), String> {
    let path = library_root(&app)?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建资料库目录：{error}"))?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("explorer.exe")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法在文件资源管理器中打开资料库：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法在访达中打开资料库：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开资料库文件夹：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn migrate_library_location(
    app: AppHandle,
    destination_path: String,
    migration_id: String,
) -> Result<LibraryMigrationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        migrate_library_blocking(app, destination_path, migration_id)
    })
    .await
    .map_err(|error| format!("资料库迁移任务异常结束：{error}"))?
}

#[tauri::command]
pub fn list_library_assets(app: AppHandle, kind: String) -> Result<Vec<LibraryAsset>, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let mut items = Vec::new();
    walk_library(&root, kind, "", &mut items, 0);
    items.sort_by(|left, right| {
        left.folder
            .to_ascii_lowercase()
            .cmp(&right.folder.to_ascii_lowercase())
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
            .then_with(|| right.modified_ms.cmp(&left.modified_ms))
    });
    Ok(items)
}

#[tauri::command]
pub fn import_library_asset(
    app: AppHandle,
    kind: String,
    source_path: String,
    relative_path: Option<String>,
) -> Result<LibraryAsset, String> {
    let kind = AssetKind::from_str(&kind)?;
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("源文件不存在：{source_path}"));
    }
    if !matches_extension(source, kind) {
        return Err(format!("不是 .{} 文件", kind.extension()));
    }
    let root = kind_dir(&app, kind)?;
    let relative = if let Some(rel) = relative_path.filter(|value| !value.trim().is_empty()) {
        rel
    } else {
        source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("asset")
            .to_string()
    };
    copy_into_library(&root, kind, source, &relative)
}

#[tauri::command]
pub fn import_library_folder(
    app: AppHandle,
    kind: String,
    folder_path: String,
) -> Result<Vec<LibraryAsset>, String> {
    let kind = AssetKind::from_str(&kind)?;
    let folder = Path::new(&folder_path);
    if !folder.is_dir() {
        return Err(format!("所选路径不是文件夹：{folder_path}"));
    }
    let root = kind_dir(&app, kind)?;
    let mut files = Vec::new();
    collect_files(folder, kind, &mut files, 0)?;
    if files.is_empty() {
        return Err(format!(
            "文件夹中没有找到 .{} 文件（含子文件夹）\n路径：{folder_path}",
            kind.extension()
        ));
    }

    let root_folder_name = folder
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_segment)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Imported".to_string());

    let mut imported = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for file in &files {
        let rel_inside = match relative_from_base(folder, file) {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("{}：{error}", file.display()));
                continue;
            }
        };
        let relative = format!("{root_folder_name}/{rel_inside}");
        match copy_into_library(&root, kind, file, &relative) {
            Ok(asset) => imported.push(asset),
            Err(error) => errors.push(error),
        }
    }

    if imported.is_empty() {
        let detail = if errors.is_empty() {
            "未知原因".to_string()
        } else {
            errors.into_iter().take(5).collect::<Vec<_>>().join("；")
        };
        return Err(format!(
            "没有成功导入任何 .{} 文件（扫描到 {} 个）。{detail}",
            kind.extension(),
            files.len()
        ));
    }

    if !errors.is_empty() {
        log::warn!(
            "library folder import partial: ok={}, fail={}",
            imported.len(),
            errors.len()
        );
    }
    Ok(imported)
}

#[tauri::command]
pub fn import_library_asset_bytes(
    app: AppHandle,
    kind: String,
    relative_path: String,
    data: Vec<u8>,
) -> Result<LibraryAsset, String> {
    let kind = AssetKind::from_str(&kind)?;
    if data.is_empty() {
        return Err("文件内容为空".into());
    }
    if data.len() > kind.max_bytes() {
        return Err("文件过大，无法写入资料库".into());
    }
    let root = kind_dir(&app, kind)?;
    let normalized = normalize_relative_path(&relative_path, kind)?;
    let unique = unique_relative_path(&root, &normalized)?;
    let target = join_relative(&root, &unique);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建子文件夹失败：{error}"))?;
    }
    fs::write(&target, &data).map_err(|error| format!("写入资料库失败：{error}"))?;
    asset_from_file(kind, &root, &target, &unique)
        .ok_or_else(|| format!("写入后无法读取：{}", target.display()))
}

#[tauri::command]
pub fn read_library_asset_text(
    app: AppHandle,
    kind: String,
    relative_path: String,
) -> Result<String, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let normalized = normalize_relative_path(&relative_path, kind)?;
    let path = join_relative(&root, &normalized);
    if !path.is_file() {
        return Err(format!("资料库中找不到该文件：{normalized}"));
    }
    // Prefer lossy UTF-8: some XMP exporters include odd encodings in comments.
    let bytes = fs::read(&path).map_err(|error| format!("读取资料库文件失败：{error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn delete_library_asset(
    app: AppHandle,
    kind: String,
    relative_path: String,
) -> Result<(), String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let normalized = normalize_relative_path(&relative_path, kind)?;
    let path = join_relative(&root, &normalized);
    if !path.is_file() {
        return Err(format!("资料库中找不到该文件：{normalized}"));
    }
    fs::remove_file(&path).map_err(|error| format!("删除资料库文件失败：{error}"))?;
    prune_empty_parents(&path, &root);
    Ok(())
}

#[tauri::command]
pub fn rename_library_asset(
    app: AppHandle,
    kind: String,
    relative_path: String,
    new_name: String,
) -> Result<LibraryAsset, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let normalized = normalize_relative_path(&relative_path, kind)?;
    let source = join_relative(&root, &normalized);
    if !source.is_file() {
        return Err(format!("资料库中找不到该文件：{normalized}"));
    }

    let folder = folder_of(&normalized);
    let next_file = sanitize_segment(new_name.trim());
    let next_file = {
        let lower = next_file.to_ascii_lowercase();
        let ext = format!(".{}", kind.extension());
        if lower.ends_with(&ext) {
            next_file
        } else {
            format!("{next_file}{ext}")
        }
    };
    let next_rel = if folder.is_empty() {
        next_file
    } else {
        format!("{folder}/{next_file}")
    };
    let unique = unique_relative_path(&root, &next_rel)?;
    if unique == normalized {
        return asset_from_file(kind, &root, &source, &normalized)
            .ok_or_else(|| "无法读取资料库条目".into());
    }
    let target = join_relative(&root, &unique);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建子文件夹失败：{error}"))?;
    }
    fs::rename(&source, &target).map_err(|error| format!("重命名失败：{error}"))?;
    prune_empty_parents(&source, &root);
    asset_from_file(kind, &root, &target, &unique)
        .ok_or_else(|| "重命名后无法读取资料库条目".into())
}

/// Normalize a folder-only relative path (no file extension).
fn normalize_folder_path(raw: &str) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    for part in raw.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("相对路径不能包含上级目录".into());
        }
        parts.push(sanitize_segment(part));
    }
    if parts.is_empty() {
        return Err("文件夹路径无效".into());
    }
    if parts.len() > MAX_FOLDER_DEPTH {
        return Err(format!("文件夹层级不能超过 {MAX_FOLDER_DEPTH} 层"));
    }
    Ok(parts.join("/"))
}

fn is_under_folder(relative: &str, folder: &str) -> bool {
    relative == folder || relative.starts_with(&format!("{folder}/"))
}

fn prune_empty_parents(start: &Path, root: &Path) {
    let mut parent = start.parent().map(Path::to_path_buf);
    while let Some(dir) = parent {
        if dir == *root {
            break;
        }
        let is_empty = fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            break;
        }
        let _ = fs::remove_dir(&dir);
        parent = dir.parent().map(Path::to_path_buf);
    }
}

fn list_assets_under_folder(root: &Path, kind: AssetKind, folder: &str) -> Vec<LibraryAsset> {
    let mut items = Vec::new();
    walk_library(root, kind, "", &mut items, 0);
    items
        .into_iter()
        .filter(|asset| {
            is_under_folder(&asset.folder, folder) || is_under_folder(&asset.relative_path, folder)
        })
        .collect()
}

fn move_file_in_library(
    root: &Path,
    kind: AssetKind,
    from_relative: &str,
    to_relative: &str,
) -> Result<LibraryAsset, String> {
    let normalized_from = normalize_relative_path(from_relative, kind)?;
    let source = join_relative(root, &normalized_from);
    if !source.is_file() {
        return Err(format!("资料库中找不到该文件：{normalized_from}"));
    }
    let unique = unique_relative_path(root, to_relative)?;
    if unique == normalized_from {
        return asset_from_file(kind, root, &source, &normalized_from)
            .ok_or_else(|| "无法读取资料库条目".into());
    }
    let target = join_relative(root, &unique);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建子文件夹失败：{error}"))?;
    }
    fs::rename(&source, &target).map_err(|error| format!("移动失败：{error}"))?;
    prune_empty_parents(&source, root);
    asset_from_file(kind, root, &target, &unique).ok_or_else(|| "移动后无法读取资料库条目".into())
}

#[tauri::command]
pub fn rename_library_folder(
    app: AppHandle,
    kind: String,
    folder_path: String,
    new_name: String,
) -> Result<Vec<LibraryAsset>, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let folder = normalize_folder_path(&folder_path)?;
    let parent = folder_of(&folder);
    let next_name = sanitize_segment(new_name.trim());
    if next_name.is_empty() {
        return Err("文件夹名称不能为空".into());
    }
    let next_folder = if parent.is_empty() {
        next_name
    } else {
        format!("{parent}/{next_name}")
    };
    if next_folder == folder {
        return Ok(list_assets_under_folder(&root, kind, &folder));
    }
    if is_under_folder(&next_folder, &folder) {
        return Err("不能将文件夹重命名到自身内部".into());
    }

    let source_dir = join_relative(&root, &folder);
    if !source_dir.is_dir() {
        return Err(format!("资料库中找不到该文件夹：{folder}"));
    }
    let target_dir = join_relative(&root, &next_folder);
    if target_dir.exists() {
        return Err(format!("目标文件夹已存在：{next_folder}"));
    }
    if let Some(parent_dir) = target_dir.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| format!("创建父文件夹失败：{error}"))?;
    }
    fs::rename(&source_dir, &target_dir).map_err(|error| format!("重命名文件夹失败：{error}"))?;
    prune_empty_parents(&source_dir, &root);
    Ok(list_assets_under_folder(&root, kind, &next_folder))
}

#[tauri::command]
pub fn delete_library_folder(
    app: AppHandle,
    kind: String,
    folder_path: String,
) -> Result<u32, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let folder = normalize_folder_path(&folder_path)?;
    let dir = join_relative(&root, &folder);
    if !dir.is_dir() {
        return Err(format!("资料库中找不到该文件夹：{folder}"));
    }

    let assets = list_assets_under_folder(&root, kind, &folder);
    let mut deleted = 0u32;
    for asset in &assets {
        let path = join_relative(&root, &asset.relative_path);
        if path.is_file() {
            fs::remove_file(&path).map_err(|error| format!("删除资料库文件失败：{error}"))?;
            deleted += 1;
        }
    }
    // Remove the folder tree (remaining empty dirs / stray files not of this kind).
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|error| format!("删除文件夹失败：{error}"))?;
    }
    prune_empty_parents(&dir, &root);
    Ok(deleted)
}

#[tauri::command]
pub fn move_library_asset(
    app: AppHandle,
    kind: String,
    relative_path: String,
    target_folder: String,
) -> Result<LibraryAsset, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let normalized = normalize_relative_path(&relative_path, kind)?;
    let target = if target_folder.trim().is_empty() {
        String::new()
    } else {
        normalize_folder_path(&target_folder)?
    };
    if folder_of(&normalized) == target {
        let path = join_relative(&root, &normalized);
        return asset_from_file(kind, &root, &path, &normalized)
            .ok_or_else(|| "无法读取资料库条目".into());
    }
    let file_name = basename_of(&normalized);
    let next_rel = if target.is_empty() {
        file_name
    } else {
        format!("{target}/{file_name}")
    };
    let next_norm = normalize_relative_path(&next_rel, kind)?;
    move_file_in_library(&root, kind, &normalized, &next_norm)
}

#[tauri::command]
pub fn move_library_folder(
    app: AppHandle,
    kind: String,
    folder_path: String,
    target_parent: String,
) -> Result<Vec<LibraryAsset>, String> {
    let kind = AssetKind::from_str(&kind)?;
    let root = kind_dir(&app, kind)?;
    let folder = normalize_folder_path(&folder_path)?;
    let parent = if target_parent.trim().is_empty() {
        String::new()
    } else {
        normalize_folder_path(&target_parent)?
    };
    let name = basename_of(&folder);
    let next_folder = if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    };
    if next_folder == folder {
        return Ok(list_assets_under_folder(&root, kind, &folder));
    }
    if is_under_folder(&next_folder, &folder) || next_folder == folder {
        return Err("不能将文件夹移动到自身或其子文件夹中".into());
    }
    if folder_of(&folder) == parent {
        return Ok(list_assets_under_folder(&root, kind, &folder));
    }

    let source_dir = join_relative(&root, &folder);
    if !source_dir.is_dir() {
        return Err(format!("资料库中找不到该文件夹：{folder}"));
    }
    let target_dir = join_relative(&root, &next_folder);
    if target_dir.exists() {
        return Err(format!("目标位置已存在同名文件夹：{next_folder}"));
    }
    if let Some(parent_dir) = target_dir.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| format!("创建父文件夹失败：{error}"))?;
    }
    fs::rename(&source_dir, &target_dir).map_err(|error| format!("移动文件夹失败：{error}"))?;
    prune_empty_parents(&source_dir, &root);
    Ok(list_assets_under_folder(&root, kind, &next_folder))
}

#[cfg(test)]
mod tests {
    use super::{
        is_under_folder, matches_extension, normalize_folder_path, normalize_relative_path,
        AssetKind,
    };
    use std::path::Path;

    #[test]
    fn normalizes_nested_xmp_paths() {
        let path = normalize_relative_path(r"Portrait\Warm\look.xmp", AssetKind::Xmp).unwrap();
        assert_eq!(path, "Portrait/Warm/look.xmp");
    }

    #[test]
    fn matches_xmp_extension_case_insensitively() {
        assert!(matches_extension(Path::new("a.XMP"), AssetKind::Xmp));
        assert!(matches_extension(Path::new("b.xmp"), AssetKind::Xmp));
        assert!(!matches_extension(Path::new("c.jpg"), AssetKind::Xmp));
    }

    #[test]
    fn normalizes_folder_paths() {
        assert_eq!(
            normalize_folder_path(r"Portrait\Warm").unwrap(),
            "Portrait/Warm"
        );
    }

    #[test]
    fn detects_folder_membership() {
        assert!(is_under_folder("Portrait/Warm", "Portrait"));
        assert!(is_under_folder("Portrait", "Portrait"));
        assert!(!is_under_folder("PortraitX", "Portrait"));
    }
}
