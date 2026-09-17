//! 图片属性：工作区内容页右键菜单的「打开所在位置 / 属性 / 删除」。
//!
//! ## 为什么自己解析 EXIF
//!
//! 本项目的依赖必须能离线构建（新 crate 拉不下来），所以不能引入 `kamadak-exif` 之类的新依赖。
//! 属性弹窗只需要展示字段，不需要 MakerNote，于是这里实现一个小解析器：
//!
//! 1. **容器定位**：JPEG(APP1) / PNG(eXIf) / WebP(EXIF) / TIFF 系（含 CR2、NEF、ARW、DNG、PEF、RW2、ORF 等）。
//! 2. **IFD 遍历**：只走 IFD0、ExifIFD、GPS IFD 三层。读取窗口之外的偏移直接跳过该条目，
//!    绝不为了一个标签把 60MB 的 RAW 整文件读进内存。
//! 3. **兜底**：以上都拿不到时（CR3 的 BMFF、RAF 的专有结构）改用已有依赖 rawler 的元数据通路。
//!
//! 两条来源填同一个 [`ExifView`]，枚举翻译 / 单位 / 分数约分因此只写一份，
//! 命令返回的也是「已分组的展示字段」，前端只负责渲染，不必跟着 EXIF 标签表改。

use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Command;

use tauri::AppHandle;

use crate::workspace::{
    remove_workspace_photos, system_time_ms, workspace_photo_context, WorkspaceManifest,
    WorkspacePhotoContext,
};

// ---------------------------------------------------------------------------
// 命令返回值
// ---------------------------------------------------------------------------

/// 属性弹窗里的一行：标签 + 已格式化的值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesField {
    pub label: String,
    pub value: String,
}

/// 属性弹窗里的一组：如「曝光」「相机与镜头」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesGroup {
    pub title: String,
    pub fields: Vec<PropertiesField>,
}

/// 一张图片的完整属性。文件系统信息给数字、EXIF 给成品文案：
/// 日期的本地化与时区换算交给前端（`toLocaleString`），拍摄参数在 Rust 侧定稿。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePhotoProperties {
    pub photo_id: String,
    pub file_name: String,
    pub relative_source_path: String,
    pub source_path: String,
    pub workspace_path: Option<String>,
    /// 当前真实读取路径（副本 → originals/，引用 → 挂载点）。
    pub resolved_path: Option<String>,
    pub origin: String,
    pub status: String,
    /// 卷未挂载 / 文件已删除等原因，正常时为 null。
    pub status_reason: Option<String>,
    pub volume_id: String,
    pub is_raw: bool,
    pub extension: String,
    pub size_bytes: u64,
    /// 实际读取文件在磁盘上的修改时间；文件不可读时为 null。
    pub modified_ms: Option<u64>,
    pub edited_at: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// EXIF 来源：`file`（自行解析原文件）/ `rawler`（RAW 元数据兜底）。
    pub exif_source: Option<String>,
    /// 没解析到 EXIF 时的说明；有数据时为 null。
    pub exif_note: Option<String>,
    pub exif_groups: Vec<PropertiesGroup>,
}

/// 批量删除的返回值。manifest 是删除后的最新版本，前端直接接管即可。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkspacePhotosReport {
    pub manifest: WorkspaceManifest,
    pub removed_photo_ids: Vec<String>,
    pub removed_files: u32,
    pub freed_bytes: u64,
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 读取一张图片的属性（文件信息 + EXIF），供「属性」弹窗使用。
#[tauri::command]
pub fn read_workspace_photo_properties(
    app: AppHandle,
    workspace_id: String,
    photo_id: String,
) -> Result<WorkspacePhotoProperties, String> {
    let context = workspace_photo_context(&app, &workspace_id, &photo_id)?;
    Ok(collect_properties(&context))
}

/// 在系统文件管理器里定位图片，返回被定位的路径（前端用于提示）。
///
/// 优先定位**原始文件**——用户右键「打开所在位置」想知道的是自己的照片放在哪，
/// 而不是应用把副本藏到了哪个 AppData 目录。原始文件不在时（卷未挂载、已被移动）
/// 退回工作区副本；两者都不可用则明确报错，不去打开一个不存在的位置。
#[tauri::command]
pub fn reveal_photo_location(
    app: AppHandle,
    workspace_id: String,
    photo_id: String,
) -> Result<String, String> {
    let context = workspace_photo_context(&app, &workspace_id, &photo_id)?;
    let source = Path::new(&context.photo.source_path);
    let target = if source.is_file() {
        source.to_path_buf()
    } else {
        match context.resolved.path.as_deref().map(Path::new) {
            Some(path) if path.is_file() => path.to_path_buf(),
            _ => return Err("找不到文件：原始位置已不可访问，工作区也没有可用副本".into()),
        }
    };
    reveal_in_file_manager(&target)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 从工作区删除若干图片（多选批量共用这一条命令）。
///
/// 只删 manifest 条目与工作区自己的副本/缩略图，不删源文件；详见
/// `crate::workspace::remove_workspace_photos`。
#[tauri::command]
pub fn delete_workspace_photos(
    app: AppHandle,
    workspace_id: String,
    photo_ids: Vec<String>,
) -> Result<DeleteWorkspacePhotosReport, String> {
    let removal = remove_workspace_photos(&app, &workspace_id, &photo_ids)?;
    Ok(DeleteWorkspacePhotosReport {
        manifest: removal.manifest,
        removed_photo_ids: removal.removed_photo_ids,
        removed_files: removal.removed_files,
        freed_bytes: removal.freed_bytes,
    })
}

// ---------------------------------------------------------------------------
// 属性组装
// ---------------------------------------------------------------------------

fn collect_properties(context: &WorkspacePhotoContext) -> WorkspacePhotoProperties {
    let photo = &context.photo;
    let resolved_path = context.resolved.path.clone();
    let file_facts = resolved_path
        .as_deref()
        .and_then(|path| std::fs::metadata(path).ok());
    let size_bytes = file_facts
        .as_ref()
        .map(|metadata| metadata.len())
        .unwrap_or(photo.size_bytes);
    let modified_ms = file_facts
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .map(system_time_ms);

    let exif = match resolved_path.as_deref() {
        Some(path) => read_exif(Path::new(path), photo.is_raw),
        None => ExifResult {
            note: Some(
                context
                    .resolved
                    .reason
                    .clone()
                    .unwrap_or_else(|| "文件当前不可读取".into()),
            ),
            ..ExifResult::default()
        },
    };

    // 尺寸三级回退：manifest 里记的（导入时读到的）→ EXIF 声明的 → 现读文件头。
    let mut width = photo.width;
    let mut height = photo.height;
    if let Some((pixel_x, pixel_y)) = exif.pixel_size {
        width = width.or(Some(pixel_x));
        height = height.or(Some(pixel_y));
    }
    if (width.is_none() || height.is_none()) && !photo.is_raw {
        if let Some(path) = resolved_path.as_deref() {
            if let Ok((read_width, read_height)) = image::image_dimensions(path) {
                width = width.or(Some(read_width));
                height = height.or(Some(read_height));
            }
        }
    }

    let file_name = file_name_of(photo);
    WorkspacePhotoProperties {
        photo_id: photo.id.clone(),
        extension: file_name
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .unwrap_or_default(),
        file_name,
        relative_source_path: photo.relative_source_path.clone(),
        source_path: photo.source_path.clone(),
        workspace_path: photo.workspace_path.clone(),
        resolved_path,
        origin: photo.origin.clone(),
        status: photo.status.clone(),
        // ready / copying 属于正常流程，只有异常状态才值得在弹窗里解释一句。
        status_reason: match photo.status.as_str() {
            "ready" | "copying" => None,
            _ => context.resolved.reason.clone(),
        },
        volume_id: photo.volume_id.clone(),
        is_raw: photo.is_raw,
        size_bytes,
        modified_ms,
        edited_at: photo.edited_at,
        width,
        height,
        exif_source: exif.source,
        exif_note: exif.note,
        exif_groups: exif.groups,
    }
}

fn file_name_of(photo: &crate::workspace::WorkspacePhoto) -> String {
    photo
        .relative_source_path
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .or_else(|| photo.source_path.rsplit(['/', '\\']).next())
        .unwrap_or("image")
        .to_string()
}

// ---------------------------------------------------------------------------
// 定位文件
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let text = path.to_string_lossy().into_owned();
    let mut command = Command::new("explorer.exe");
    // `/select,` 与路径之间不能有空格，且参数用逗号分隔；路径本身带逗号或引号时
    // explorer 会把它拆成两个参数。那种情况下退化为打开父目录——打开错东西比
    // 「点了没反应」更难排查。
    if text.contains(',') || text.contains('"') {
        if let Some(parent) = path.parent() {
            command.arg(parent);
        }
    } else {
        command.arg(format!("/select,{text}"));
    }
    command
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("无法在文件资源管理器中定位该文件：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法在访达中定位该文件：{error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    // 多数 Linux 文件管理器没有「打开并选中」的通用开关，退化为打开所在目录。
    let parent = path.parent().unwrap_or(path);
    Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map_err(|error| format!("无法打开文件所在目录：{error}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// EXIF：容器定位
// ---------------------------------------------------------------------------

/// TIFF 头的读取窗口。IFD0 / ExifIFD / GPS IFD 与实际用到的字符串几乎都在文件头若干 KB 内，
/// 而 CR2 / NEF 动辄 30–60MB，所以窗口之外的偏移一律当作「没有」。
const TIFF_WINDOW_BYTES: usize = 1024 * 1024;
/// 单个段的上限，防止畸形长度字段让读取爆炸。
const MAX_SEGMENT_BYTES: usize = 4 * 1024 * 1024;
/// 扫描步数上限：段数量异常的文件不能变成死循环。
const MAX_SCAN_STEPS: usize = 4096;
/// 单个 IFD 的条目数上限（真实文件最多几百条）。
const MAX_IFD_ENTRIES: usize = 4096;

#[derive(Default)]
struct ExifResult {
    groups: Vec<PropertiesGroup>,
    note: Option<String>,
    source: Option<String>,
    pixel_size: Option<(u32, u32)>,
}

fn read_exif(path: &Path, is_raw: bool) -> ExifResult {
    match File::open(path) {
        Ok(file) => {
            let mut reader = BufReader::new(file);
            match scan_exif_block(&mut reader) {
                Ok(Some(block)) => {
                    if let Some(view) = parse_exif(&block) {
                        let pixel_size = view.pixel_size();
                        let groups = view.groups();
                        if !groups.is_empty() {
                            return ExifResult {
                                groups,
                                note: None,
                                source: Some("file".into()),
                                pixel_size,
                            };
                        }
                    }
                }
                Ok(None) => {}
                // 同上：错误正文里可能带路径，只记事件本身。
                Err(_) => log::warn!("EXIF 定位失败"),
            }
        }
        Err(error) => {
            return ExifResult {
                note: Some(format!("无法打开文件：{error}")),
                ..ExifResult::default()
            }
        }
    }

    // CR3（BMFF）、RAF 等容器走 rawler 的元数据通路兜底。
    if is_raw {
        if let Some(metadata) = read_rawler_metadata(path) {
            let view = exif_view_from_rawler(&metadata);
            let pixel_size = view.pixel_size();
            let groups = view.groups();
            if !groups.is_empty() {
                return ExifResult {
                    groups,
                    note: None,
                    source: Some("rawler".into()),
                    pixel_size,
                };
            }
        }
    }

    ExifResult {
        note: Some("该文件未包含可读取的 EXIF 信息".into()),
        ..ExifResult::default()
    }
}

/// 从任意容器里取出 EXIF 块（TIFF 结构，偏移以块首为基准）。
fn scan_exif_block<R: Read + Seek>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    let head = read_window(reader, 0, 64)?;
    if head.len() >= 2 && head[0] == 0xFF && head[1] == 0xD8 {
        return jpeg_exif_block(reader);
    }
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return png_exif_block(reader);
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        return webp_exif_block(reader);
    }
    if is_tiff_header(&head) {
        // TIFF 系（含绝大多数相机 RAW）：IFD0 就在文件头，整窗交给 IFD 解析器。
        return read_window(reader, 0, TIFF_WINDOW_BYTES).map(Some);
    }
    Ok(None)
}

fn jpeg_exif_block<R: Read + Seek>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    reader
        .seek(SeekFrom::Start(2))
        .map_err(|error| format!("无法读取图片：{error}"))?;
    for _ in 0..MAX_SCAN_STEPS {
        let Some(marker) = read_marker(reader)? else {
            return Ok(None);
        };
        match marker {
            // 无长度字段的段：SOI / TEM / RSTn。
            0xD8 | 0x01 | 0xD0..=0xD7 => continue,
            // SOS 之后是压缩数据，EXIF 不可能再出现。
            0xDA => return Ok(None),
            _ => {}
        }
        let Some(length) = read_length(reader, Endian::Big)? else {
            return Ok(None);
        };
        let payload = length.saturating_sub(2);
        if marker == 0xE1 && payload >= 6 {
            let data = read_exact_bytes(reader, payload)?;
            if let Some(block) = data.strip_prefix(b"Exif\0\0") {
                if is_tiff_header(block) {
                    return Ok(Some(block.to_vec()));
                }
            }
            // XMP 等其它 APP1 段：继续找下一段。
            continue;
        }
        reader
            .seek(SeekFrom::Current(payload as i64))
            .map_err(|error| format!("无法读取图片：{error}"))?;
    }
    Ok(None)
}

fn png_exif_block<R: Read + Seek>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    reader
        .seek(SeekFrom::Start(8))
        .map_err(|error| format!("无法读取图片：{error}"))?;
    for _ in 0..MAX_SCAN_STEPS {
        let Some(header) = read_header(reader, 8)? else {
            return Ok(None);
        };
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let kind = &header[4..8];
        if kind == b"IEND" {
            return Ok(None);
        }
        if kind == b"eXIf" {
            // PNG 的 eXIf 块内容直接就是 TIFF 块，没有 JPEG 的 "Exif\0\0" 前缀。
            if !(8..=MAX_SEGMENT_BYTES).contains(&length) {
                return Ok(None);
            }
            let block = read_exact_bytes(reader, length)?;
            return Ok(if is_tiff_header(&block) {
                Some(block)
            } else {
                None
            });
        }
        // 跳过长块而不是放弃：IDAT 动辄几 MB，而 eXIf 完全可以排在图像数据之后。
        // seek 不分配内存，所以这里本来就不需要那个上限（上限只用于「真读进内存」的目标块）。
        reader
            .seek(SeekFrom::Current((length as u64).saturating_add(4) as i64))
            .map_err(|error| format!("无法读取图片：{error}"))?;
    }
    Ok(None)
}

fn webp_exif_block<R: Read + Seek>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    reader
        .seek(SeekFrom::Start(12))
        .map_err(|error| format!("无法读取图片：{error}"))?;
    for _ in 0..MAX_SCAN_STEPS {
        let Some(header) = read_header(reader, 8)? else {
            return Ok(None);
        };
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let padded = length.saturating_add(length & 1);
        if &header[..4] == b"EXIF" {
            if !(8..=MAX_SEGMENT_BYTES).contains(&length) {
                return Ok(None);
            }
            let data = read_exact_bytes(reader, length)?;
            let block = data
                .strip_prefix(b"Exif\0\0")
                .map(<[u8]>::to_vec)
                .unwrap_or(data);
            return Ok(if is_tiff_header(&block) {
                Some(block)
            } else {
                None
            });
        }
        // 同上：VP8 图像数据常有十几 MB，跳过它继续找 EXIF，而不是整段放弃。
        reader
            .seek(SeekFrom::Current(padded as i64))
            .map_err(|error| format!("无法读取图片：{error}"))?;
    }
    Ok(None)
}

/// 读 JPEG 段起始标记。段间允许出现填充与垃圾字节，这里按 0xFF 前缀重新同步。
fn read_marker<R: Read + Seek>(reader: &mut R) -> Result<Option<u8>, String> {
    let mut byte = [0u8; 1];
    for _ in 0..MAX_SCAN_STEPS {
        match reader.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => {
                if byte[0] != 0xFF {
                    continue;
                }
                match reader.read(&mut byte) {
                    Ok(0) => return Ok(None),
                    Ok(_) => match byte[0] {
                        0xFF => continue, // 填充
                        0x00 => continue, // 压缩数据里的转义字节，不该出现在段之间
                        marker => return Ok(Some(marker)),
                    },
                    Err(error) => return Err(format!("无法读取图片：{error}")),
                }
            }
            Err(error) => return Err(format!("无法读取图片：{error}")),
        }
    }
    Ok(None)
}

fn is_tiff_header(head: &[u8]) -> bool {
    if head.len() < 8 {
        return false;
    }
    let endian = match &head[..2] {
        b"II" => Endian::Little,
        b"MM" => Endian::Big,
        _ => return false,
    };
    if u16_at(head, 2, endian) == Some(42) {
        // 标准 TIFF，以及 CR2 / NEF / ARW / DNG / PEF / SRW / RWL 等（都是 TIFF 变体）。
        return true;
    }
    // 各家 RAW 的私有魔数：ORF 的 "IIRO"/"IIRS"、RW2 的 "IIU\0"、MMOR。
    // 魔数不是 42，但 IFD0 偏移同样写在 4..8 字节。
    let magic = head.get(2..4).unwrap_or_default();
    (endian == Endian::Little && (magic == b"RO" || magic == b"RS" || magic == b"U\0"))
        || (endian == Endian::Big && (magic == b"OR" || magic == b"U\0"))
}

fn read_window<R: Read + Seek>(
    reader: &mut R,
    offset: u64,
    limit: usize,
) -> Result<Vec<u8>, String> {
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| format!("无法读取图片：{error}"))?;
    let mut buffer = Vec::new();
    let mut remaining = limit;
    let mut chunk = [0u8; 16 * 1024];
    while remaining > 0 {
        let want = remaining.min(chunk.len());
        let read = reader
            .read(&mut chunk[..want])
            .map_err(|error| format!("无法读取图片：{error}"))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        remaining -= read;
    }
    Ok(buffer)
}

/// 读到文件尾属于正常情况（返回 None），其它 IO 错误才上报。
fn read_header<R: Read>(reader: &mut R, length: usize) -> Result<Option<Vec<u8>>, String> {
    let mut buffer = vec![0u8; length];
    match reader.read_exact(&mut buffer) {
        Ok(()) => Ok(Some(buffer)),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(format!("无法读取图片：{error}")),
    }
}

fn read_exact_bytes<R: Read>(reader: &mut R, length: usize) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0u8; length];
    reader
        .read_exact(&mut buffer)
        .map_err(|error| format!("无法读取图片：{error}"))?;
    Ok(buffer)
}

fn read_length<R: Read>(reader: &mut R, endian: Endian) -> Result<Option<usize>, String> {
    let Some(bytes) = read_header(reader, 2)? else {
        return Ok(None);
    };
    Ok(Some(u16_at(&bytes, 0, endian).unwrap_or(0) as usize))
}

// ---------------------------------------------------------------------------
// EXIF：TIFF / IFD 解析
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Endian {
    Little,
    Big,
}

fn u16_at(bytes: &[u8], offset: usize, endian: Endian) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(match endian {
        Endian::Little => u16::from_le_bytes([slice[0], slice[1]]),
        Endian::Big => u16::from_be_bytes([slice[0], slice[1]]),
    })
}

fn u32_at(bytes: &[u8], offset: usize, endian: Endian) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    let array = [slice[0], slice[1], slice[2], slice[3]];
    Some(match endian {
        Endian::Little => u32::from_le_bytes(array),
        Endian::Big => u32::from_be_bytes(array),
    })
}

fn i32_at(bytes: &[u8], offset: usize, endian: Endian) -> Option<i32> {
    let slice = bytes.get(offset..offset + 4)?;
    let array = [slice[0], slice[1], slice[2], slice[3]];
    Some(match endian {
        Endian::Little => i32::from_le_bytes(array),
        Endian::Big => i32::from_be_bytes(array),
    })
}

/// TIFF 数据类型 → 单值字节数（3 号 ASCII、4 号 SHORT 等）。
fn type_size(field_type: u16) -> Option<usize> {
    Some(match field_type {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => return None,
    })
}

#[derive(Clone, Copy)]
struct TiffEntry {
    tag: u16,
    field_type: u16,
    count: u32,
    /// 4 字节内联值在块中的位置（值不超过 4 字节时用它）。
    inline_at: usize,
    /// 值超过 4 字节时相对 TIFF 块首的偏移。
    offset: u32,
}

struct Tiff<'a> {
    data: &'a [u8],
    endian: Endian,
}

impl<'a> Tiff<'a> {
    fn new(data: &'a [u8]) -> Option<Self> {
        if data.len() < 8 {
            return None;
        }
        let endian = match &data[..2] {
            b"II" => Endian::Little,
            b"MM" => Endian::Big,
            _ => return None,
        };
        Some(Self { data, endian })
    }

    fn u16(&self, offset: usize) -> Option<u16> {
        u16_at(self.data, offset, self.endian)
    }

    fn u32(&self, offset: usize) -> Option<u32> {
        u32_at(self.data, offset, self.endian)
    }

    /// 解析一个 IFD。偏移越界、条目数异常时返回空表而不是报错：
    /// 属性弹窗少几行比整条命令失败好。
    fn ifd(&self, offset: usize) -> Vec<TiffEntry> {
        let Some(raw_count) = self.u16(offset) else {
            return Vec::new();
        };
        let count = raw_count as usize;
        if count == 0 || count > MAX_IFD_ENTRIES {
            return Vec::new();
        }
        let mut entries = Vec::with_capacity(count.min(64));
        for index in 0..count {
            // IFD 偏移来自文件里的 u32；饱和加法避免 32 位目标上 usize 溢出（debug 会 panic）。
            let base = offset.saturating_add(2 + index * 12);
            let (Some(tag), Some(field_type), Some(value_count)) = (
                self.u16(base),
                self.u16(base.saturating_add(2)),
                self.u32(base.saturating_add(4)),
            ) else {
                break;
            };
            let inline_at = base.saturating_add(8);
            if self
                .data
                .get(inline_at..inline_at.saturating_add(4))
                .is_none()
            {
                break;
            }
            entries.push(TiffEntry {
                tag,
                field_type,
                count: value_count,
                inline_at,
                offset: self.u32(inline_at).unwrap_or(0),
            });
        }
        entries
    }

    /// 条目数据的原始字节：不超过 4 字节的内联存放，否则按偏移取。
    fn entry_bytes(&self, entry: &TiffEntry) -> Option<&'a [u8]> {
        let size = type_size(entry.field_type)?.checked_mul(entry.count as usize)?;
        if size == 0 {
            return None;
        }
        if size <= 4 {
            return self.data.get(entry.inline_at..entry.inline_at + size);
        }
        let start = entry.offset as usize;
        self.data.get(start..start.checked_add(size)?)
    }

    fn text(&self, entry: &TiffEntry) -> Option<String> {
        if entry.field_type != 2 {
            return None;
        }
        let bytes = self.entry_bytes(entry)?;
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        non_empty(&String::from_utf8_lossy(&bytes[..end]))
    }

    /// EXIF 版本这类 UNDEFINED 字段：里面其实是 ASCII 数字。
    fn version_text(&self, entry: &TiffEntry) -> Option<String> {
        let bytes = self.entry_bytes(entry)?;
        let text: String = bytes
            .iter()
            .filter(|byte| byte.is_ascii_graphic())
            .map(|byte| *byte as char)
            .collect();
        non_empty(&text)
    }

    fn unsigned(&self, entry: &TiffEntry, index: usize) -> Option<u32> {
        let bytes = self.entry_bytes(entry)?;
        match entry.field_type {
            1 | 7 => bytes.get(index).map(|value| u32::from(*value)),
            3 => u16_at(bytes, index * 2, self.endian).map(u32::from),
            4 => u32_at(bytes, index * 4, self.endian),
            _ => None,
        }
    }

    fn number(&self, entry: &TiffEntry, index: usize) -> Option<(i64, i64)> {
        let bytes = self.entry_bytes(entry)?;
        match entry.field_type {
            5 => Some((
                i64::from(u32_at(bytes, index * 8, self.endian)?),
                i64::from(u32_at(bytes, index * 8 + 4, self.endian)?),
            )),
            10 => Some((
                i64::from(i32_at(bytes, index * 8, self.endian)?),
                i64::from(i32_at(bytes, index * 8 + 4, self.endian)?),
            )),
            // 有些写入方用整数类型代替有理数：按 /1 处理，而不是丢掉整个字段。
            _ => self
                .unsigned(entry, index)
                .map(|value| (i64::from(value), 1)),
        }
    }

    fn numbers<const N: usize>(&self, entry: &TiffEntry) -> Option<[(i64, i64); N]> {
        let mut values = [(0i64, 1i64); N];
        for (index, slot) in values.iter_mut().enumerate() {
            *slot = self.number(entry, index)?;
        }
        Some(values)
    }
}

fn find(entries: &[TiffEntry], tag: u16) -> Option<&TiffEntry> {
    entries.iter().find(|entry| entry.tag == tag)
}

fn parse_exif(block: &[u8]) -> Option<ExifView> {
    let tiff = Tiff::new(block)?;
    let roots = tiff.ifd(tiff.u32(4)? as usize);
    if roots.is_empty() {
        return None;
    }

    let mut view = ExifView::default();
    fill_ifd0(&tiff, &roots, &mut view);
    // 少数文件把 ExifIFD 的标签直接写在 IFD0 里，所以 IFD0 也走一遍曝光解析；
    // 后写入的真实 ExifIFD 会覆盖它，不会产生两套值。
    fill_exif_ifd(&tiff, &roots, &mut view);
    if let Some(offset) = find(&roots, 0x8769).and_then(|entry| tiff.unsigned(entry, 0)) {
        let entries = tiff.ifd(offset as usize);
        fill_exif_ifd(&tiff, &entries, &mut view);
    }
    if let Some(offset) = find(&roots, 0x8825).and_then(|entry| tiff.unsigned(entry, 0)) {
        let entries = tiff.ifd(offset as usize);
        fill_gps_ifd(&tiff, &entries, &mut view);
    }
    Some(view)
}

fn fill_ifd0(tiff: &Tiff, entries: &[TiffEntry], view: &mut ExifView) {
    set_text(tiff, entries, 0x010F, &mut view.make); // Make
    set_text(tiff, entries, 0x0110, &mut view.model); // Model
    set_text(tiff, entries, 0x010E, &mut view.description); // ImageDescription
    set_text(tiff, entries, 0x0131, &mut view.software); // Software
    set_text(tiff, entries, 0x0132, &mut view.date_time); // DateTime
    set_text(tiff, entries, 0x013B, &mut view.artist); // Artist
    set_text(tiff, entries, 0x8298, &mut view.copyright); // Copyright
    set_u16(tiff, entries, 0x0112, &mut view.orientation); // Orientation
    set_u16(tiff, entries, 0x0128, &mut view.resolution_unit); // ResolutionUnit
    set_number(tiff, entries, 0x011A, &mut view.x_resolution); // XResolution
    set_number(tiff, entries, 0x011B, &mut view.y_resolution); // YResolution
}

fn fill_exif_ifd(tiff: &Tiff, entries: &[TiffEntry], view: &mut ExifView) {
    set_text(tiff, entries, 0x9003, &mut view.date_time_original); // DateTimeOriginal
    set_text(tiff, entries, 0x9004, &mut view.date_time_digitized); // DateTimeDigitized
    set_text(tiff, entries, 0x9291, &mut view.sub_sec); // SubSecTimeOriginal
    set_text(tiff, entries, 0xA433, &mut view.lens_make); // LensMake
    set_text(tiff, entries, 0xA434, &mut view.lens_model); // LensModel
    set_text(tiff, entries, 0xA435, &mut view.lens_serial); // LensSerialNumber
    set_text(tiff, entries, 0xA431, &mut view.body_serial); // BodySerialNumber
    set_text(tiff, entries, 0xA430, &mut view.owner); // CameraOwnerName
    if view.offset_time.is_none() {
        // OffsetTimeOriginal(0x9011) 优先，其次 OffsetTime(0x9010)。
        set_text(tiff, entries, 0x9011, &mut view.offset_time);
        set_text(tiff, entries, 0x9010, &mut view.offset_time);
    }
    if let Some(entry) = find(entries, 0xA432) {
        // LensSpecification：4 个有理数（最短/最长焦距、最短/最长光圈）。
        if let Some(parts) = tiff.numbers::<4>(entry) {
            view.lens_spec = format_lens_spec(parts);
        }
    }
    set_number(tiff, entries, 0x829A, &mut view.exposure_time); // ExposureTime
    set_number(tiff, entries, 0x829D, &mut view.f_number); // FNumber
    set_number(tiff, entries, 0x9202, &mut view.aperture); // ApertureValue(APEX)
    set_number(tiff, entries, 0x9205, &mut view.max_aperture); // MaxApertureValue
    set_number(tiff, entries, 0x9201, &mut view.shutter_speed); // ShutterSpeedValue(APEX)
    set_number(tiff, entries, 0x9204, &mut view.exposure_bias); // ExposureBiasValue
    set_number(tiff, entries, 0x920A, &mut view.focal_length); // FocalLength
    set_number(tiff, entries, 0x9206, &mut view.subject_distance); // SubjectDistance
    set_u16(tiff, entries, 0x8822, &mut view.exposure_program);
    set_u16(tiff, entries, 0xA402, &mut view.exposure_mode);
    set_u16(tiff, entries, 0x9207, &mut view.metering_mode);
    set_u16(tiff, entries, 0x9208, &mut view.light_source);
    set_u16(tiff, entries, 0x9209, &mut view.flash);
    set_u16(tiff, entries, 0xA403, &mut view.white_balance);
    set_u16(tiff, entries, 0xA001, &mut view.color_space);
    set_u16(tiff, entries, 0xA406, &mut view.scene_capture_type);
    set_u32(tiff, entries, 0xA405, &mut view.focal_length_35mm); // FocalLengthIn35mmFilm
    set_u32(tiff, entries, 0xA002, &mut view.pixel_x); // PixelXDimension
    set_u32(tiff, entries, 0xA003, &mut view.pixel_y); // PixelYDimension
    if view.iso.is_none() {
        // 0x8827 是 SHORT 数组（旧格式），0x8833 是 LONG（SensitivityType 之后）。
        if let Some(value) = find(entries, 0x8827).and_then(|entry| tiff.unsigned(entry, 0)) {
            view.iso = Some(value);
        } else if let Some(value) = find(entries, 0x8833).and_then(|entry| tiff.unsigned(entry, 0))
        {
            view.iso = Some(value);
        }
    }
    if view.exif_version.is_none() {
        if let Some(entry) = find(entries, 0x9000) {
            view.exif_version = tiff.version_text(entry); // ExifVersion
        }
    }
}

fn fill_gps_ifd(tiff: &Tiff, entries: &[TiffEntry], view: &mut ExifView) {
    let latitude_ref = find(entries, 0x0001).and_then(|entry| tiff.text(entry)); // GPSLatitudeRef
    let latitude = find(entries, 0x0002).and_then(|entry| tiff.numbers::<3>(entry)); // GPSLatitude
    view.latitude = format_gps_coordinate(latitude_ref.as_deref(), latitude);

    let longitude_ref = find(entries, 0x0003).and_then(|entry| tiff.text(entry)); // GPSLongitudeRef
    let longitude = find(entries, 0x0004).and_then(|entry| tiff.numbers::<3>(entry)); // GPSLongitude
    view.longitude = format_gps_coordinate(longitude_ref.as_deref(), longitude);

    if let Some(value) = find(entries, 0x0006)
        .and_then(|entry| tiff.number(entry, 0))
        .and_then(ratio)
    {
        // GPSAltitudeRef：0 = 海平面以上，1 = 海平面以下。
        let below = find(entries, 0x0005)
            .and_then(|entry| tiff.unsigned(entry, 0))
            .map(|flag| flag == 1)
            .unwrap_or(false);
        view.altitude = Some(format!(
            "{} 米（海平面{}）",
            format_number(value, 1),
            if below { "以下" } else { "以上" }
        ));
    }
    if let Some(parts) = find(entries, 0x0007).and_then(|entry| tiff.numbers::<3>(entry)) {
        view.gps_timestamp = format_gps_clock(parts); // GPSTimeStamp
    }
    if let Some(value) = find(entries, 0x0011)
        .and_then(|entry| tiff.number(entry, 0))
        .and_then(ratio)
    {
        view.gps_direction = Some(format!("{}°", format_number(value, 1))); // GPSImgDirection
    }
    view.gps_datum = find(entries, 0x0012).and_then(|entry| tiff.text(entry)); // GPSMapDatum
    view.gps_date = find(entries, 0x001D).and_then(|entry| tiff.text(entry)); // GPSDateStamp
}

fn set_text(tiff: &Tiff, entries: &[TiffEntry], tag: u16, slot: &mut Option<String>) {
    if let Some(value) = find(entries, tag).and_then(|entry| tiff.text(entry)) {
        *slot = Some(value);
    }
}

fn set_u16(tiff: &Tiff, entries: &[TiffEntry], tag: u16, slot: &mut Option<u16>) {
    if let Some(value) = find(entries, tag).and_then(|entry| tiff.unsigned(entry, 0)) {
        *slot = Some(value as u16);
    }
}

fn set_u32(tiff: &Tiff, entries: &[TiffEntry], tag: u16, slot: &mut Option<u32>) {
    if let Some(value) = find(entries, tag).and_then(|entry| tiff.unsigned(entry, 0)) {
        *slot = Some(value);
    }
}

fn set_number(tiff: &Tiff, entries: &[TiffEntry], tag: u16, slot: &mut Option<(i64, i64)>) {
    if let Some(value) = find(entries, tag).and_then(|entry| tiff.number(entry, 0)) {
        *slot = Some(value);
    }
}

// ---------------------------------------------------------------------------
// EXIF：RAW 元数据兜底（rawler）
// ---------------------------------------------------------------------------

fn read_rawler_metadata(path: &Path) -> Option<rawler::decoders::RawMetadata> {
    use rawler::decoders::RawDecodeParams;

    let file = File::open(path).ok()?;
    let mut raw_file = rawler::RawFile::new(path, BufReader::new(file));
    let decoder = match rawler::get_decoder(&mut raw_file) {
        Ok(decoder) => decoder,
        Err(_) => {
            log::warn!("RAW 格式识别失败");
            return None;
        }
    };
    match decoder.raw_metadata(&mut raw_file, RawDecodeParams::default()) {
        Ok(metadata) => Some(metadata),
        Err(_) => {
            // 只记录「没读到」，不带错误正文：rawler 的错误可能包含完整文件路径，
            // 而日志规范不允许记录用户路径与 EXIF 内容。
            log::warn!("RAW 元数据读取失败");
            None
        }
    }
}

fn exif_view_from_rawler(metadata: &rawler::decoders::RawMetadata) -> ExifView {
    let exif = &metadata.exif;
    let pair = |value: rawler::formats::tiff::Rational| (i64::from(value.n), i64::from(value.d));
    let signed_pair =
        |value: rawler::formats::tiff::SRational| (i64::from(value.n), i64::from(value.d));

    let mut view = ExifView {
        make: non_empty(&metadata.make),
        model: non_empty(&metadata.model),
        artist: exif.artist.clone().and_then(|value| non_empty(&value)),
        copyright: exif.copyright.clone().and_then(|value| non_empty(&value)),
        owner: exif.owner_name.clone().and_then(|value| non_empty(&value)),
        lens_make: exif.lens_make.clone().and_then(|value| non_empty(&value)),
        lens_model: exif.lens_model.clone().and_then(|value| non_empty(&value)),
        lens_serial: exif
            .lens_serial_number
            .clone()
            .and_then(|value| non_empty(&value)),
        body_serial: exif
            .serial_number
            .clone()
            .and_then(|value| non_empty(&value)),
        date_time: exif.modify_date.clone(),
        date_time_original: exif.date_time_original.clone(),
        date_time_digitized: exif.create_date.clone(),
        offset_time: exif
            .offset_time_original
            .clone()
            .or_else(|| exif.offset_time.clone()),
        sub_sec: exif.sub_sec_time_original.clone(),
        exposure_time: exif.exposure_time.map(pair),
        shutter_speed: exif.shutter_speed_value.map(signed_pair),
        f_number: exif.fnumber.map(pair),
        aperture: exif.aperture_value.map(pair),
        max_aperture: exif.max_aperture_value.map(pair),
        exposure_bias: exif.exposure_bias.map(signed_pair),
        exposure_program: exif.exposure_program,
        exposure_mode: exif.exposure_mode,
        metering_mode: exif.metering_mode,
        light_source: exif.light_source,
        flash: exif.flash,
        white_balance: exif.white_balance,
        iso: exif.iso_speed_ratings.map(u32::from).or(exif.iso_speed),
        focal_length: exif.focal_length.map(pair),
        subject_distance: exif.subject_distance.map(pair),
        scene_capture_type: exif.scene_capture_type,
        orientation: exif.orientation,
        color_space: exif.color_space,
        ..ExifView::default()
    };

    if let Some(spec) = exif.lens_spec {
        view.lens_spec = format_lens_spec(spec.map(pair));
    }
    if let Some(gps) = &exif.gps {
        view.latitude = format_gps_coordinate(
            gps.gps_latitude_ref.as_deref(),
            gps.gps_latitude.map(|values| values.map(pair)),
        );
        view.longitude = format_gps_coordinate(
            gps.gps_longitude_ref.as_deref(),
            gps.gps_longitude.map(|values| values.map(pair)),
        );
        if let Some(value) = gps.gps_altitude.map(pair).and_then(ratio) {
            view.altitude = Some(format!(
                "{} 米（海平面{}）",
                format_number(value, 1),
                if gps.gps_altitude_ref == Some(1) {
                    "以下"
                } else {
                    "以上"
                }
            ));
        }
        view.gps_timestamp = gps
            .gps_timestamp
            .and_then(|values| format_gps_clock(values.map(pair)));
        view.gps_direction = gps
            .gps_img_direction
            .map(pair)
            .and_then(ratio)
            .map(|value| format!("{}°", format_number(value, 1)));
        view.gps_datum = gps
            .gps_map_datum
            .clone()
            .and_then(|value| non_empty(&value));
        view.gps_date = gps
            .gps_date_stamp
            .clone()
            .and_then(|value| non_empty(&value));
    }
    view
}

// ---------------------------------------------------------------------------
// EXIF：展示映射（两种来源共用）
// ---------------------------------------------------------------------------

/// 展示用的中间表示：自解析与 rawler 兜底两条来源都填这一个结构，
/// 枚举翻译、单位换算、分数约分因此只写一份。
#[derive(Default)]
struct ExifView {
    date_time_original: Option<String>,
    date_time_digitized: Option<String>,
    date_time: Option<String>,
    offset_time: Option<String>,
    sub_sec: Option<String>,
    make: Option<String>,
    model: Option<String>,
    lens_make: Option<String>,
    lens_model: Option<String>,
    lens_spec: Option<String>,
    lens_serial: Option<String>,
    body_serial: Option<String>,
    exposure_time: Option<(i64, i64)>,
    shutter_speed: Option<(i64, i64)>,
    f_number: Option<(i64, i64)>,
    aperture: Option<(i64, i64)>,
    max_aperture: Option<(i64, i64)>,
    exposure_bias: Option<(i64, i64)>,
    exposure_program: Option<u16>,
    exposure_mode: Option<u16>,
    metering_mode: Option<u16>,
    light_source: Option<u16>,
    flash: Option<u16>,
    white_balance: Option<u16>,
    iso: Option<u32>,
    focal_length: Option<(i64, i64)>,
    focal_length_35mm: Option<u32>,
    subject_distance: Option<(i64, i64)>,
    scene_capture_type: Option<u16>,
    pixel_x: Option<u32>,
    pixel_y: Option<u32>,
    orientation: Option<u16>,
    color_space: Option<u16>,
    x_resolution: Option<(i64, i64)>,
    y_resolution: Option<(i64, i64)>,
    resolution_unit: Option<u16>,
    exif_version: Option<String>,
    owner: Option<String>,
    artist: Option<String>,
    copyright: Option<String>,
    software: Option<String>,
    description: Option<String>,
    latitude: Option<String>,
    longitude: Option<String>,
    altitude: Option<String>,
    gps_timestamp: Option<String>,
    gps_direction: Option<String>,
    gps_datum: Option<String>,
    gps_date: Option<String>,
}

impl ExifView {
    fn pixel_size(&self) -> Option<(u32, u32)> {
        Some((self.pixel_x?, self.pixel_y?))
    }

    /// 组装成弹窗要显示的分组；没有值的分组不返回（空分组不该在界面上占位置）。
    fn groups(&self) -> Vec<PropertiesGroup> {
        let mut groups = Vec::new();

        push_group(
            &mut groups,
            "拍摄",
            vec![
                (
                    "拍摄时间",
                    self.date_time_original
                        .as_deref()
                        .and_then(format_exif_datetime),
                ),
                (
                    "数字化时间",
                    self.date_time_digitized
                        .as_deref()
                        .and_then(format_exif_datetime),
                ),
                (
                    "文件修改时间",
                    self.date_time.as_deref().and_then(format_exif_datetime),
                ),
                ("时区偏移", self.offset_time.clone()),
                ("亚秒时间", self.sub_sec.clone()),
            ],
        );

        push_group(
            &mut groups,
            "相机与镜头",
            vec![
                ("厂商", self.make.clone()),
                ("型号", self.model.clone()),
                ("镜头", self.lens_model.clone()),
                ("镜头厂商", self.lens_make.clone()),
                ("镜头规格", self.lens_spec.clone()),
                ("镜头序列号", self.lens_serial.clone()),
                ("机身序列号", self.body_serial.clone()),
            ],
        );

        push_group(
            &mut groups,
            "曝光",
            vec![
                ("光圈", self.f_number.and_then(format_aperture)),
                ("最大光圈", self.max_aperture.and_then(format_aperture)),
                ("快门", self.exposure_time.and_then(format_exposure_time)),
                (
                    "快门速度 (APEX)",
                    self.shutter_speed.and_then(format_shutter_apex),
                ),
                ("ISO", self.iso.map(|value| format!("ISO {value}"))),
                (
                    "曝光补偿",
                    self.exposure_bias.and_then(format_exposure_bias),
                ),
                (
                    "曝光程序",
                    self.exposure_program.map(exposure_program_label),
                ),
                ("曝光模式", self.exposure_mode.map(exposure_mode_label)),
                ("测光模式", self.metering_mode.map(metering_mode_label)),
                ("光源", self.light_source.map(light_source_label)),
                ("闪光灯", self.flash.map(flash_label)),
                ("白平衡", self.white_balance.map(white_balance_label)),
                ("焦距", self.focal_length.and_then(format_focal_length)),
                (
                    "等效焦距",
                    self.focal_length_35mm.map(|value| format!("{value} mm")),
                ),
                ("主体距离", self.subject_distance.and_then(format_distance)),
                ("场景类型", self.scene_capture_type.map(scene_capture_label)),
                ("光圈 (APEX)", self.aperture.and_then(format_aperture_apex)),
            ],
        );

        push_group(
            &mut groups,
            "图像",
            vec![
                (
                    "像素尺寸",
                    self.pixel_size()
                        .map(|(width, height)| format!("{width} × {height}")),
                ),
                ("方向", self.orientation.map(orientation_label)),
                ("色彩空间", self.color_space.map(color_space_label)),
                ("分辨率", self.resolution()),
                ("EXIF 版本", self.exif_version.clone()),
                ("图像描述", self.description.clone()),
            ],
        );

        push_group(
            &mut groups,
            "作者与版权",
            vec![
                ("所有者", self.owner.clone()),
                ("艺术家", self.artist.clone()),
                ("版权", self.copyright.clone()),
                ("软件", self.software.clone()),
            ],
        );

        push_group(
            &mut groups,
            "定位",
            vec![
                ("纬度", self.latitude.clone()),
                ("经度", self.longitude.clone()),
                ("海拔", self.altitude.clone()),
                ("时间 (UTC)", self.gps_timestamp.clone()),
                ("拍摄日期", self.gps_date.clone()),
                ("方向", self.gps_direction.clone()),
                ("大地基准面", self.gps_datum.clone()),
            ],
        );

        groups
    }

    fn resolution(&self) -> Option<String> {
        let unit = match self.resolution_unit {
            Some(3) => " 每厘米",
            _ => " dpi",
        };
        match (ratio(self.x_resolution?), ratio(self.y_resolution?)) {
            (Some(x), Some(y)) if (x - y).abs() < 0.5 => {
                Some(format!("{}{unit}", format_number(x, 0)))
            }
            (Some(x), Some(y)) => Some(format!(
                "{} × {}{unit}",
                format_number(x, 0),
                format_number(y, 0)
            )),
            _ => None,
        }
    }
}

fn push_group(
    groups: &mut Vec<PropertiesGroup>,
    title: &str,
    candidates: Vec<(&str, Option<String>)>,
) {
    let fields = candidates
        .into_iter()
        .filter_map(|(label, value)| {
            let value = value?;
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some(PropertiesField {
                label: label.to_string(),
                value: trimmed.to_string(),
            })
        })
        .collect::<Vec<_>>();
    if !fields.is_empty() {
        groups.push(PropertiesGroup {
            title: title.to_string(),
            fields,
        });
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// EXIF：数值格式化
// ---------------------------------------------------------------------------

/// 有理数 → f64。分母为 0 视为没有值（相机偶尔会写 0/0）。
fn ratio(pair: (i64, i64)) -> Option<f64> {
    let (numerator, denominator) = pair;
    if denominator == 0 {
        return None;
    }
    Some(numerator as f64 / denominator as f64)
}

/// 定点小数，去掉无意义的尾零（2.80 → 2.8，3.00 → 3）。
fn format_number(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return "—".into();
    }
    let text = format!("{value:.digits$}");
    if !text.contains('.') {
        return text;
    }
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" {
        "0".into()
    } else {
        trimmed.to_string()
    }
}

/// 秒数 → 「1/250 秒」或「2 秒」。
fn format_seconds(value: f64) -> Option<String> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    if value >= 1.0 {
        return Some(format!("{} 秒", format_number(value, 1)));
    }
    Some(format!("1/{} 秒", (1.0 / value).round().max(1.0) as i64))
}

fn format_exposure_time(pair: (i64, i64)) -> Option<String> {
    ratio(pair).and_then(format_seconds)
}

/// ShutterSpeedValue 是 APEX：秒数 = 2^-APEX。
fn format_shutter_apex(pair: (i64, i64)) -> Option<String> {
    ratio(pair).and_then(|apex| format_seconds(2f64.powf(-apex)))
}

fn format_aperture(pair: (i64, i64)) -> Option<String> {
    ratio(pair).map(|value| format!("f/{}", format_number(value, 1)))
}

/// ApertureValue 是 APEX：光圈 = 2^(APEX/2)。
fn format_aperture_apex(pair: (i64, i64)) -> Option<String> {
    ratio(pair).map(|apex| format!("f/{}", format_number(2f64.powf(apex / 2.0), 1)))
}

fn format_exposure_bias(pair: (i64, i64)) -> Option<String> {
    let value = ratio(pair)?;
    if value == 0.0 {
        return Some("0 EV".into());
    }
    let magnitude = format_number(value.abs(), 1);
    Some(if value > 0.0 {
        format!("+{magnitude} EV")
    } else {
        format!("-{magnitude} EV")
    })
}

fn format_focal_length(pair: (i64, i64)) -> Option<String> {
    ratio(pair).map(|value| format!("{} mm", format_number(value, 1)))
}

fn format_distance(pair: (i64, i64)) -> Option<String> {
    let value = ratio(pair)?;
    // 0 表示「未知距离」（EXIF 规范），极大值表示「无穷远」：两者都不该显示成具体米数。
    if value <= 0.0 {
        return None;
    }
    if value >= 1000.0 {
        return Some("无限远".into());
    }
    Some(format!("{} 米", format_number(value, 2)))
}

fn format_lens_spec(parts: [(i64, i64); 4]) -> Option<String> {
    let min_focal = ratio(parts[0])?;
    let max_focal = ratio(parts[1])?;
    let min_aperture = ratio(parts[2])?;
    let max_aperture = ratio(parts[3])?;
    if min_focal <= 0.0 || min_aperture <= 0.0 {
        return None;
    }
    let focal = if (max_focal - min_focal).abs() < 0.05 || max_focal <= 0.0 {
        format!("{} mm", format_number(min_focal, 1))
    } else {
        format!(
            "{}-{} mm",
            format_number(min_focal, 1),
            format_number(max_focal, 1)
        )
    };
    let aperture = if (max_aperture - min_aperture).abs() < 0.05 || max_aperture <= 0.0 {
        format!("f/{}", format_number(min_aperture, 1))
    } else {
        format!(
            "f/{}-{}",
            format_number(min_aperture, 1),
            format_number(max_aperture, 1)
        )
    };
    Some(format!("{focal} {aperture}"))
}

/// EXIF 的日期是 "2024:05:01 10:20:30"；只把日期部分的冒号换成连字符，其余原样。
fn format_exif_datetime(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with("0000") {
        return None;
    }
    let mut chars: Vec<char> = trimmed.chars().collect();
    if chars.len() >= 10 && chars[4] == ':' && chars[7] == ':' {
        chars[4] = '-';
        chars[7] = '-';
    }
    Some(chars.into_iter().collect())
}

fn format_gps_coordinate(
    reference: Option<&str>,
    degrees: Option<[(i64, i64); 3]>,
) -> Option<String> {
    let parts = degrees?;
    let mut value = 0.0;
    for (index, part) in parts.iter().enumerate() {
        let part_value = ratio(*part)?;
        value += match index {
            0 => part_value,
            1 => part_value / 60.0,
            _ => part_value / 3600.0,
        };
    }
    if value == 0.0 {
        return None;
    }
    let suffix = reference.unwrap_or("").trim();
    Some(if suffix.is_empty() {
        format!("{value:.6}°")
    } else {
        format!("{value:.6}° {suffix}")
    })
}

fn format_gps_clock(parts: [(i64, i64); 3]) -> Option<String> {
    let hour = ratio(parts[0])?;
    let minute = ratio(parts[1])?;
    let second = ratio(parts[2])?;
    Some(format!(
        "{:02}:{:02}:{:02}",
        hour as u32, minute as u32, second as u32
    ))
}

fn orientation_label(value: u16) -> String {
    match value {
        2 => "水平镜像",
        3 => "旋转 180°",
        4 => "垂直镜像",
        5 => "顺时针 90° + 水平镜像",
        6 => "顺时针 90°",
        7 => "逆时针 90° + 水平镜像",
        8 => "逆时针 90°",
        _ => "正常",
    }
    .to_string()
}

fn exposure_program_label(value: u16) -> String {
    match value {
        1 => "手动",
        2 => "程序自动",
        3 => "光圈优先",
        4 => "快门优先",
        5 => "创意（景深优先）",
        6 => "动作（高速快门）",
        7 => "人像",
        8 => "风景",
        _ => "未定义",
    }
    .to_string()
}

fn exposure_mode_label(value: u16) -> String {
    match value {
        1 => "手动曝光",
        2 => "自动包围曝光",
        _ => "自动曝光",
    }
    .to_string()
}

fn metering_mode_label(value: u16) -> String {
    match value {
        1 => "平均测光",
        2 => "中央重点平均测光",
        3 => "点测光",
        4 => "多点测光",
        5 => "评价测光",
        6 => "局部测光",
        _ => "未知",
    }
    .to_string()
}

fn light_source_label(value: u16) -> String {
    match value {
        1 => "日光",
        2 => "荧光灯",
        3 => "白炽灯",
        4 => "闪光灯",
        9 => "晴天",
        10 => "阴天",
        11 => "阴影",
        12 => "日光荧光灯",
        13 => "日光白炽灯",
        14 => "多云",
        15 => "自定义",
        17 => "标准光 A",
        18 => "标准光 B",
        19 => "标准光 C",
        20 => "D55",
        21 => "D65",
        22 => "D75",
        23 => "D50",
        24 => "ISO 棚拍灯",
        _ => "未知",
    }
    .to_string()
}

fn flash_label(value: u16) -> String {
    let mut text = if value & 0x1 == 0 {
        "未闪光"
    } else {
        "已闪光"
    }
    .to_string();
    if value & 0x40 != 0 {
        text.push_str("（防红眼）");
    }
    text
}

fn white_balance_label(value: u16) -> String {
    match value {
        1 => "手动",
        _ => "自动",
    }
    .to_string()
}

fn color_space_label(value: u16) -> String {
    match value {
        1 => "sRGB",
        2 => "Adobe RGB",
        0xFFFF => "未校准",
        _ => "未定义",
    }
    .to_string()
}

fn scene_capture_label(value: u16) -> String {
    match value {
        1 => "风景",
        2 => "人像",
        3 => "夜景",
        _ => "标准",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// IFD 条目：12 字节，最后 4 字节要么是内联值，要么是值区的偏移。
    fn entry(tag: u16, field_type: u16, count: u32, payload: u32) -> [u8; 12] {
        let mut bytes = [0u8; 12];
        bytes[0..2].copy_from_slice(&tag.to_le_bytes());
        bytes[2..4].copy_from_slice(&field_type.to_le_bytes());
        bytes[4..8].copy_from_slice(&count.to_le_bytes());
        bytes[8..12].copy_from_slice(&payload.to_le_bytes());
        bytes
    }

    /// 组装一个最小的小端 TIFF：IFD0(Make/Model/ExifIFD/GPS) + ExifIFD + GPS IFD。
    /// 布局写死并用 assert 卡住，偏移算错时测试会立刻指出来，而不是解析出空结果。
    fn sample_tiff() -> Vec<u8> {
        const IFD0_AT: usize = 8;
        const EXIF_AT: usize = 62;
        const GPS_AT: usize = 116;
        const DATA_AT: usize = 170;

        let make = b"Canon\0";
        let model = b"EOS R5\0";
        let date = b"2024:05:01 10:20:30\0";
        let lat_ref = b"N\0";
        let lat: [[u32; 2]; 3] = [[40, 1], [30, 1], [0, 1]];
        let long_ref = b"E\0";
        let long: [[u32; 2]; 3] = [[116, 1], [20, 1], [0, 1]];

        let make_at = DATA_AT;
        let model_at = make_at + make.len();
        let exposure_at = model_at + model.len();
        let f_number_at = exposure_at + 8;
        let date_at = f_number_at + 8;
        let lat_ref_at = date_at + date.len();
        let lat_at = lat_ref_at + lat_ref.len();
        let long_ref_at = lat_at + 24;
        let long_at = long_ref_at + long_ref.len();

        let mut data = vec![b'I', b'I', 42, 0];
        data.extend_from_slice(&(IFD0_AT as u32).to_le_bytes());

        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(&entry(0x010F, 2, make.len() as u32, make_at as u32));
        data.extend_from_slice(&entry(0x0110, 2, model.len() as u32, model_at as u32));
        data.extend_from_slice(&entry(0x8769, 4, 1, EXIF_AT as u32));
        data.extend_from_slice(&entry(0x8825, 4, 1, GPS_AT as u32));
        data.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(data.len(), EXIF_AT);

        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(&entry(0x829A, 5, 1, exposure_at as u32));
        data.extend_from_slice(&entry(0x829D, 5, 1, f_number_at as u32));
        data.extend_from_slice(&entry(0x8827, 3, 1, 100));
        data.extend_from_slice(&entry(0x9003, 2, date.len() as u32, date_at as u32));
        data.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(data.len(), GPS_AT);

        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(&entry(0x0001, 2, 2, u32::from(b'N')));
        data.extend_from_slice(&entry(0x0002, 5, 3, lat_at as u32));
        // 2 字节的 ASCII 在 IFD 里是内联存放的，写成「偏移 + 值区」反而会被解析成垃圾字节。
        data.extend_from_slice(&entry(0x0003, 2, 2, u32::from(b'E')));
        data.extend_from_slice(&entry(0x0004, 5, 3, long_at as u32));
        data.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(data.len(), DATA_AT);

        data.extend_from_slice(make);
        data.extend_from_slice(model);
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&250u32.to_le_bytes());
        data.extend_from_slice(&28u32.to_le_bytes());
        data.extend_from_slice(&10u32.to_le_bytes());
        data.extend_from_slice(date);
        data.extend_from_slice(lat_ref);
        for value in lat {
            data.extend_from_slice(&value[0].to_le_bytes());
            data.extend_from_slice(&value[1].to_le_bytes());
        }
        data.extend_from_slice(long_ref);
        for value in long {
            data.extend_from_slice(&value[0].to_le_bytes());
            data.extend_from_slice(&value[1].to_le_bytes());
        }
        data
    }

    fn field_value<'a>(groups: &'a [PropertiesGroup], title: &str, label: &str) -> Option<&'a str> {
        groups
            .iter()
            .find(|group| group.title == title)?
            .fields
            .iter()
            .find(|field| field.label == label)
            .map(|field| field.value.as_str())
    }

    #[test]
    fn parses_ifd0_exif_and_gps() {
        let view = parse_exif(&sample_tiff()).expect("样例 TIFF 应能解析");
        let groups = view.groups();

        assert_eq!(field_value(&groups, "相机与镜头", "厂商"), Some("Canon"));
        assert_eq!(field_value(&groups, "相机与镜头", "型号"), Some("EOS R5"));
        assert_eq!(
            field_value(&groups, "拍摄", "拍摄时间"),
            Some("2024-05-01 10:20:30")
        );
        assert_eq!(field_value(&groups, "曝光", "快门"), Some("1/250 秒"));
        assert_eq!(field_value(&groups, "曝光", "光圈"), Some("f/2.8"));
        assert_eq!(field_value(&groups, "曝光", "ISO"), Some("ISO 100"));
        assert_eq!(field_value(&groups, "定位", "纬度"), Some("40.500000° N"));
        assert_eq!(field_value(&groups, "定位", "经度"), Some("116.333333° E"));
        // 没有值的分组不该出现。
        assert!(groups.iter().all(|group| !group.fields.is_empty()));
    }

    #[test]
    fn finds_exif_block_in_jpeg_after_other_segments() {
        let tiff = sample_tiff();
        let mut jpeg = vec![0xFF, 0xD8];
        // 前置一个 APP0(JFIF)：扫描必须能按长度跳过它。
        jpeg.extend_from_slice(&[0xFF, 0xE0]);
        jpeg.extend_from_slice(&16u16.to_be_bytes());
        jpeg.extend_from_slice(&[0u8; 14]);
        // 前置一个 XMP 的 APP1：不是 Exif，应继续往后找。
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&8u16.to_be_bytes());
        jpeg.extend_from_slice(b"http: ");
        let payload = 6 + tiff.len();
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&((payload + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&tiff);

        let found = scan_exif_block(&mut Cursor::new(jpeg))
            .expect("扫描不应报错")
            .expect("应找到 EXIF 块");
        assert_eq!(found, tiff);
    }

    #[test]
    fn finds_exif_block_in_png_and_webp() {
        let tiff = sample_tiff();

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0u8; 13]);
        png.extend_from_slice(&[0u8; 4]);
        png.extend_from_slice(&(tiff.len() as u32).to_be_bytes());
        png.extend_from_slice(b"eXIf");
        png.extend_from_slice(&tiff);
        png.extend_from_slice(&[0u8; 4]);
        assert_eq!(
            scan_exif_block(&mut Cursor::new(png)).unwrap(),
            Some(tiff.clone())
        );

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&0u32.to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"VP8X");
        webp.extend_from_slice(&10u32.to_le_bytes());
        webp.extend_from_slice(&[0u8; 10]);
        let mut exif_chunk = b"Exif\0\0".to_vec();
        exif_chunk.extend_from_slice(&tiff);
        webp.extend_from_slice(b"EXIF");
        webp.extend_from_slice(&(exif_chunk.len() as u32).to_le_bytes());
        webp.extend_from_slice(&exif_chunk);
        assert_eq!(scan_exif_block(&mut Cursor::new(webp)).unwrap(), Some(tiff));
    }
    #[test]
    fn finds_exif_after_a_multi_megabyte_png_chunk() {
        // 真实图片的图像数据段动辄十几 MB，而 eXIf / EXIF 完全可以排在它之后：
        // 扫描必须「跳过」而不是「整段放弃」，否则这类文件的属性弹窗永远显示没有 EXIF。
        let tiff = sample_tiff();
        let idat = vec![0u8; MAX_SEGMENT_BYTES + 1024];

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&(idat.len() as u32).to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&idat);
        png.extend_from_slice(&[0u8; 4]);
        png.extend_from_slice(&(tiff.len() as u32).to_be_bytes());
        png.extend_from_slice(b"eXIf");
        png.extend_from_slice(&tiff);
        png.extend_from_slice(&[0u8; 4]);
        assert_eq!(
            scan_exif_block(&mut Cursor::new(png)).unwrap(),
            Some(tiff.clone())
        );

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&0u32.to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"VP8 ");
        webp.extend_from_slice(&(idat.len() as u32).to_le_bytes());
        webp.extend_from_slice(&idat);
        if idat.len() % 2 == 1 {
            webp.push(0);
        }
        let mut exif_chunk = b"Exif\0\0".to_vec();
        exif_chunk.extend_from_slice(&tiff);
        webp.extend_from_slice(b"EXIF");
        webp.extend_from_slice(&(exif_chunk.len() as u32).to_le_bytes());
        webp.extend_from_slice(&exif_chunk);
        assert_eq!(scan_exif_block(&mut Cursor::new(webp)).unwrap(), Some(tiff));
    }

    #[test]
    fn non_image_input_yields_no_exif() {
        let bytes = b"not an image at all, just text".to_vec();
        assert_eq!(scan_exif_block(&mut Cursor::new(bytes)).unwrap(), None);
    }

    #[test]
    fn truncated_tiff_falls_back_to_empty_groups() {
        // 头部声明的 IFD 偏移越界：应得到空视图而不是 panic。
        let bytes = vec![b'I', b'I', 42, 0, 250, 0, 0, 0];
        let view = parse_exif(&bytes).unwrap_or_default();
        assert!(view.groups().is_empty());
    }

    #[test]
    fn formats_photographic_values() {
        assert_eq!(
            format_exposure_time((10, 2500)).as_deref(),
            Some("1/250 秒")
        );
        assert_eq!(format_exposure_time((5, 10)).as_deref(), Some("1/2 秒"));
        assert_eq!(format_exposure_time((2, 1)).as_deref(), Some("2 秒"));
        assert_eq!(format_exposure_time((0, 0)), None);
        assert_eq!(format_aperture((28, 10)).as_deref(), Some("f/2.8"));
        assert_eq!(format_exposure_bias((1, 3)).as_deref(), Some("+0.3 EV"));
        assert_eq!(format_exposure_bias((-2, 3)).as_deref(), Some("-0.7 EV"));
        assert_eq!(format_exposure_bias((0, 1)).as_deref(), Some("0 EV"));
        assert_eq!(format_focal_length((35, 1)).as_deref(), Some("35 mm"));
        // 0 表示「未知距离」，极大值表示「无穷远」：两者都不该显示成具体米数。
        assert_eq!(format_distance((0, 1)), None);
        assert_eq!(format_distance((4294967295, 1)).as_deref(), Some("无限远"));
        assert_eq!(
            format_lens_spec([(16, 1), (35, 1), (28, 10), (4, 1)]).as_deref(),
            Some("16-35 mm f/2.8-4")
        );
        assert_eq!(
            format_exif_datetime("2024:05:01 10:20:30").as_deref(),
            Some("2024-05-01 10:20:30")
        );
        assert_eq!(format_exif_datetime("0000:00:00 00:00:00"), None);
        assert_eq!(format_number(2.0, 1), "2");
        assert_eq!(format_number(100.0, 1), "100");
        assert_eq!(format_number(2.8, 1), "2.8");
        assert_eq!(orientation_label(6), "顺时针 90°");
        assert_eq!(flash_label(0), "未闪光");
    }
}
