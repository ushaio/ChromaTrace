mod asset_library;
mod credentials;
mod model_client;
mod photo_info;
mod raw_decode;
mod workspace;

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
            raw_decode::decode_raw_file,
            raw_decode::decode_raw_thumbnail,
            workspace::list_workspaces,
            workspace::create_workspace,
            workspace::rename_workspace,
            workspace::delete_workspace,
            workspace::read_workspace_manifest,
            workspace::write_workspace_manifest,
            workspace::classify_source_volumes,
            workspace::resolve_volume_mount,
            workspace::get_volume_policies,
            workspace::set_volume_policy,
            workspace::clear_volume_policies,
            workspace::clear_volume_policy,
            workspace::import_workspace_files,
            workspace::cancel_workspace_import,
            workspace::import_workspace_reference,
            workspace::resolve_workspace_reference_path,
            workspace::resolve_workspace_photo_paths,
            workspace::list_absent_workspace_volumes,
            workspace::read_workspace_thumbnail,
            workspace::write_workspace_thumbnail,
            workspace::purge_workspace_thumbnails,
            workspace::clear_workspace,
            workspace::workspace_disk_space,
            workspace::open_workspace_folder,
            photo_info::read_workspace_photo_properties,
            photo_info::reveal_photo_location,
            photo_info::delete_workspace_photos,
            asset_library::get_library_location,
            asset_library::open_library_folder,
            asset_library::migrate_library_location,
            asset_library::list_library_assets,
            asset_library::import_library_asset,
            asset_library::import_library_folder,
            asset_library::import_library_asset_bytes,
            asset_library::read_library_asset_text,
            asset_library::delete_library_asset,
            asset_library::rename_library_asset,
            asset_library::rename_library_folder,
            asset_library::delete_library_folder,
            asset_library::move_library_asset,
            asset_library::move_library_folder,
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
