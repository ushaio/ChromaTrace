mod credentials;
mod model_client;

use std::fs;
use std::path::Path;

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err("所选文件不存在".into());
    }
    fs::read(file_path).map_err(|error| format!("读取文件失败：{error}"))
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let file_path = Path::new(&path);
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            return Err("目标目录不存在".into());
        }
    }
    fs::write(file_path, data).map_err(|error| format!("保存文件失败：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_binary_file,
            write_binary_file,
            credentials::save_api_key,
            credentials::delete_api_key,
            credentials::has_api_key,
            model_client::test_model_connection,
            model_client::analyze_with_model,
            model_client::refine_match_with_model,
            model_client::suggest_color_workflows,
            model_client::optimize_color_prompt,
            model_client::generate_colored_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ChromaTrace");
}
