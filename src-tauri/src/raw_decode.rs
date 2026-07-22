//! Camera RAW → sRGB JPEG decode via rawler (dnglab).
//!
//! L2 policy: demosaic + camera WB/calibration + sRGB ODT (rawler defaults),
//! then encode JPEG for the existing Canvas/WebGL pipeline.
//!
//! We convert rawler's Intermediate f32 buffers ourselves so we do not couple
//! to rawler's private `image` crate version.

use image::codecs::jpeg::JpegEncoder;
use image::{ColorType, ImageEncoder, RgbImage};
use rawler::imgop::develop::{Intermediate, RawDevelop};
use std::io::Cursor;
use std::path::Path;

/// Extensions treated as camera RAW (case-insensitive).
pub const RAW_EXTENSIONS: &[&str] = &[
    "3fr", "ari", "arw", "bay", "cr2", "cr3", "crw", "cs1", "dcr", "dng", "erf", "fff", "iiq",
    "k25", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "obm", "orf", "pef", "ptx", "pxn",
    "r3d", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
];

pub fn is_raw_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            RAW_EXTENSIONS
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn encode_srgb_jpeg(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| "RAW 分辨率过大".to_string())?;
    if rgb.len() < expected {
        return Err(format!(
            "RAW 展开数据长度不足：期望 {expected}，实际 {}",
            rgb.len()
        ));
    }

    let mut buffer = Vec::with_capacity(expected / 4);
    let mut cursor = Cursor::new(&mut buffer);
    let encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
    encoder
        .write_image(&rgb[..expected], width, height, ColorType::Rgb8.into())
        .map_err(|error| format!("JPEG 编码失败：{error}"))?;
    Ok(buffer)
}

#[inline]
fn f32_to_u8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn intermediate_to_rgb8(intermediate: Intermediate) -> Result<RgbImage, String> {
    match intermediate {
        Intermediate::ThreeColor(pixels) => {
            let width = pixels.width as u32;
            let height = pixels.height as u32;
            let mut data = Vec::with_capacity(pixels.data.len() * 3);
            for pixel in &pixels.data {
                data.push(f32_to_u8(pixel[0]));
                data.push(f32_to_u8(pixel[1]));
                data.push(f32_to_u8(pixel[2]));
            }
            RgbImage::from_raw(width, height, data)
                .ok_or_else(|| "RGB 缓冲区尺寸不匹配".to_string())
        }
        Intermediate::Monochrome(pixels) => {
            let width = pixels.width as u32;
            let height = pixels.height as u32;
            let mut data = Vec::with_capacity(pixels.data.len() * 3);
            for &value in &pixels.data {
                let y = f32_to_u8(value);
                data.push(y);
                data.push(y);
                data.push(y);
            }
            RgbImage::from_raw(width, height, data)
                .ok_or_else(|| "灰度缓冲区尺寸不匹配".to_string())
        }
        Intermediate::FourColor(pixels) => {
            // Use first three channels as RGB after rawler's map steps when present.
            let width = pixels.width as u32;
            let height = pixels.height as u32;
            let mut data = Vec::with_capacity(pixels.data.len() * 3);
            for pixel in &pixels.data {
                data.push(f32_to_u8(pixel[0]));
                data.push(f32_to_u8(pixel[1]));
                data.push(f32_to_u8(pixel[2]));
            }
            RgbImage::from_raw(width, height, data)
                .ok_or_else(|| "四通道缓冲区尺寸不匹配".to_string())
        }
    }
}

/// Decode a camera RAW file into an sRGB JPEG byte stream for the frontend.
#[tauri::command]
pub fn decode_raw_file(path: String, max_side: Option<u32>) -> Result<Vec<u8>, String> {
    if !is_raw_path(&path) {
        return Err("不是已支持的相机 RAW 扩展名".into());
    }
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err("所选 RAW 文件不存在".into());
    }

    let raw_image =
        rawler::decode_file(file_path).map_err(|error| format!("RAW 解码失败：{error}"))?;

    let developed = RawDevelop::default()
        .develop_intermediate(&raw_image)
        .map_err(|error| format!("RAW 显影失败：{error}"))?;

    let mut rgb_image = intermediate_to_rgb8(developed)?;
    let max_side = max_side.unwrap_or(4000).clamp(512, 8000);
    let (width, height) = rgb_image.dimensions();
    let longest = width.max(height);
    if longest > max_side {
        let scale = max_side as f32 / longest as f32;
        let new_w = ((width as f32) * scale).round().max(1.0) as u32;
        let new_h = ((height as f32) * scale).round().max(1.0) as u32;
        rgb_image = image::imageops::resize(
            &rgb_image,
            new_w,
            new_h,
            image::imageops::FilterType::Triangle,
        );
    }

    let (out_w, out_h) = rgb_image.dimensions();
    encode_srgb_jpeg(rgb_image.as_raw(), out_w, out_h, 92)
}

#[cfg(test)]
mod tests {
    use super::is_raw_path;

    #[test]
    fn detects_common_raw_extensions() {
        assert!(is_raw_path(r"C:\photos\IMG_0001.CR2"));
        assert!(is_raw_path(r"C:\photos\a.nef"));
        assert!(is_raw_path(r"C:\photos\b.dng"));
        assert!(!is_raw_path(r"C:\photos\c.jpg"));
    }
}
