//! Base screenshot operations: crop and save, read as base64, and comparison.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use image::GenericImageView;
use tauri::Manager;

/// Crop an image and save it to the project's screenshots folder
/// Takes the source image path, crop bounds (x, y, width, height), and returns the saved path
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn crop_and_save_screenshot(
    app: tauri::AppHandle,
    project_path: String,
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;

    // The source is a throwaway full-window capture from tauri-plugin-screenshots,
    // living in a temp/cache dir — never inside a ShipStudio project. Canonicalize
    // it and require it under a known capture dir before we read or delete it, so a
    // caller can't point this command at an arbitrary file. (Mirrors the guard in
    // crop_screenshot_bytes; validate_project_path is the wrong boundary here.)
    let source_canonical = std::fs::canonicalize(&source_path)
        .map_err(|e| format!("Invalid screenshot source: {e}"))?;
    if !is_under_capture_dir(&app, &source_canonical) {
        return Err(
            format!("Screenshot source is outside the capture directory: {source_path}").into(),
        );
    }

    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let screenshot_path = screenshots_dir.join(format!("screenshot-{timestamp}.png"));
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Load the source image (guarded canonical path)
    let img = image::open(&source_canonical).map_err(|e| format!("Failed to open image: {e}"))?;

    // Crop the image (ensure bounds are within image dimensions)
    let img_width = img.width();
    let img_height = img.height();

    let crop_x = x.min(img_width.saturating_sub(1));
    let crop_y = y.min(img_height.saturating_sub(1));
    let crop_width = width.min(img_width.saturating_sub(crop_x));
    let crop_height = height.min(img_height.saturating_sub(crop_y));

    let cropped = img.crop_imm(crop_x, crop_y, crop_width, crop_height);

    // Save the cropped image
    cropped
        .save(&screenshot_path)
        .map_err(|e| format!("Failed to save cropped image: {e}"))?;

    // Clean up the source temp file (guarded canonical path)
    let _ = std::fs::remove_file(&source_canonical);

    Ok(screenshot_path_str)
}

/// Read an image from `source_path`, crop to clamped bounds, and return the
/// region PNG-encoded in memory. Pure (no filesystem side effects) so it can be
/// unit-tested directly; [`crop_screenshot_bytes`] wraps it with a path guard
/// and temp cleanup.
fn crop_png_bytes(
    source_path: &std::path::Path,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, CommandError> {
    let img = image::open(source_path).map_err(|e| format!("Failed to open image: {e}"))?;

    let img_width = img.width();
    let img_height = img.height();
    let crop_x = x.min(img_width.saturating_sub(1));
    let crop_y = y.min(img_height.saturating_sub(1));
    let crop_width = width.min(img_width.saturating_sub(crop_x));
    let crop_height = height.min(img_height.saturating_sub(crop_y));
    let cropped = img.crop_imm(crop_x, crop_y, crop_width, crop_height);

    let mut cursor = std::io::Cursor::new(Vec::new());
    cropped
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode cropped image: {e}"))?;
    Ok(cursor.into_inner())
}

/// True when `path` resolves inside a directory the screenshot plugin is allowed
/// to write its throwaway captures to (app cache / app local data / OS temp).
fn is_under_capture_dir(app: &tauri::AppHandle, path: &std::path::Path) -> bool {
    [
        app.path().app_cache_dir().ok(),
        app.path().app_local_data_dir().ok(),
        Some(std::env::temp_dir()),
    ]
    .into_iter()
    .flatten()
    .filter_map(|d| std::fs::canonicalize(d).ok())
    .any(|d| path.starts_with(&d))
}

/// Crop an image and return the cropped region encoded as PNG bytes (in memory).
///
/// Mirrors the crop logic of [`crop_and_save_screenshot`] but persists nothing:
/// it loads the source image, clamps the crop bounds, encodes to PNG in memory,
/// and returns the raw bytes. Tauri serializes the `Vec<u8>` as a JS `number[]`.
///
/// `source_path` is the throwaway full-window capture that tauri-plugin-screenshots
/// wrote into a temp/cache dir. We canonicalize it and require it to live under a
/// known capture dir before reading or deleting it, so a caller can't point the
/// command at an arbitrary file. (`validate_project_path` is the wrong boundary
/// here — the source is never inside a ShipStudio project.)
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn crop_screenshot_bytes(
    app: tauri::AppHandle,
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, CommandError> {
    let canonical = std::fs::canonicalize(&source_path)
        .map_err(|e| format!("Invalid screenshot source: {e}"))?;
    if !is_under_capture_dir(&app, &canonical) {
        return Err(
            format!("Screenshot source is outside the capture directory: {source_path}").into(),
        );
    }

    // Read via the validated canonical path (not the raw source_path) so we
    // can't open a different file than the one that passed the guard.
    let bytes = crop_png_bytes(&canonical, x, y, width, height)?;

    // The decoded image now lives in memory, so delete the temp capture (otherwise
    // each redline export would leak a window PNG). Guarded by the dir check above.
    let _ = std::fs::remove_file(&canonical);
    Ok(bytes)
}

/// Read a screenshot file and return it as a base64 data URL.
/// Used for displaying screenshot previews in the UI.
#[tauri::command]
#[tracing::instrument]
pub async fn get_screenshot_base64(file_path: String) -> Result<String, CommandError> {
    use base64::Engine;

    let path = std::path::PathBuf::from(&file_path);

    if !path.exists() {
        return Err((format!("Screenshot file not found: {file_path}")).into());
    }

    let data = std::fs::read(&path).map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/png;base64,{base64_data}"))
}

/// Compare two screenshot images to detect if we've hit the page bottom.
/// When scrolling stops working (page bottom reached), the BOTTOM EDGE of both
/// captures will be identical (same footer/content).
/// This is more reliable than comparing the whole image.
#[tauri::command]
#[tracing::instrument]
pub async fn compare_screenshots(
    path1: String,
    path2: String,
    _skip_header_pixels: u32, // kept for API compatibility
) -> Result<bool, CommandError> {
    let img1 = image::open(&path1).map_err(|e| format!("Failed to open image 1: {e}"))?;
    let img2 = image::open(&path2).map_err(|e| format!("Failed to open image 2: {e}"))?;

    // Different dimensions = not similar
    if img1.width() != img2.width() || img1.height() != img2.height() {
        return Ok(false);
    }

    let width = img1.width();
    let height = img1.height();

    // Compare just the bottom 100 pixels of each image
    // When we hit page bottom, both images will have the same footer
    let bottom_region = 100.min(height / 4); // At most 25% of image height
    let compare_start = height.saturating_sub(bottom_region);

    // Sample every 20th pixel for accurate comparison
    let sample_step = 20;
    let mut matching = 0;
    let mut total = 0;

    for y in (compare_start..height).step_by(sample_step as usize) {
        for x in (0..width).step_by(sample_step as usize) {
            let p1 = img1.get_pixel(x, y);
            let p2 = img2.get_pixel(x, y);
            total += 1;
            // Allow small differences due to compression artifacts
            if (p1[0] as i32 - p2[0] as i32).abs() < 10
                && (p1[1] as i32 - p2[1] as i32).abs() < 10
                && (p1[2] as i32 - p2[2] as i32).abs() < 10
            {
                matching += 1;
            }
        }
    }

    // Bottom edges are the same if >95% of sampled pixels match
    // This is strict because we're only comparing a small region
    let is_similar = total > 0 && (matching * 100 / total) > 95;

    tracing::debug!(
        "Screenshot comparison: {}/{} pixels match ({}%) - {}",
        matching,
        total,
        if total > 0 { matching * 100 / total } else { 0 },
        if is_similar { "DUPLICATE" } else { "different" }
    );

    Ok(is_similar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn crop_png_bytes_returns_png_of_cropped_dimensions() {
        // Build a small in-memory RGBA image (10x10) and write it to a temp PNG.
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(10, 10, |x, _y| Rgba([(x * 20) as u8, 0, 0, 255]));
        let mut tmp = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        tmp.push(format!("crop_png_bytes_test_{unique}.png"));
        img.save(&tmp).expect("save temp png");

        // Crop a 4x3 sub-rect at (2, 1). Tests the pure crop/encode helper; the
        // command wrapper adds the capture-dir guard + temp cleanup.
        let bytes = crop_png_bytes(&tmp, 2, 1, 4, 3).expect("crop_png_bytes should succeed");

        // The returned bytes must decode back to an image of the cropped dimensions.
        let decoded = image::load_from_memory(&bytes).expect("returned bytes should decode as PNG");
        assert_eq!(decoded.width(), 4);
        assert_eq!(decoded.height(), 3);

        let _ = std::fs::remove_file(&tmp);
    }
}
