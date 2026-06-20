//! Screenshot stitching: combine multiple viewport captures into a single full-page image.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use image::{DynamicImage, GenericImageView, RgbaImage};

/// Helper function to compare two images for similarity (returns true if they're nearly identical).
/// Focuses on the bottom 60% of each image where duplicates are most apparent.
fn images_are_similar(img1: &DynamicImage, img2: &DynamicImage, skip_header: u32) -> bool {
    // Compare dimensions first
    if img1.width() != img2.width() || img1.height() != img2.height() {
        return false;
    }

    let width = img1.width();
    let height = img1.height();

    // Focus on bottom 60% of the image (where duplicates appear when hitting page bottom)
    let content_height = height.saturating_sub(skip_header);
    let compare_start = skip_header + (content_height * 40 / 100);

    // Sample every 30th pixel for accurate comparison
    let sample_step = 30;
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

    // Images are similar if >90% of sampled pixels in the bottom half match
    total > 0 && (matching * 100 / total) > 93
}

/// Stitch multiple screenshots together vertically for full-page capture.
/// Takes multiple image paths and combines them into a single image.
/// sticky_header_height: height of fixed/sticky elements at the top to skip in subsequent captures
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn stitch_screenshots(
    project_path: String,
    image_paths: Vec<String>,
    viewport_height: u32,
    full_height: u32,
    sticky_header_height: u32,
) -> Result<String, CommandError> {
    if image_paths.is_empty() {
        return Err(("No images to stitch".to_string()).into());
    }

    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Load all images first to detect duplicates
    let mut images: Vec<DynamicImage> = Vec::new();
    let mut unique_count = 0;

    for (i, path) in image_paths.iter().enumerate() {
        let img = image::open(path).map_err(|e| format!("Failed to open image {path}: {e}"))?;

        // Check if this image is a duplicate of the previous one (we've hit the bottom)
        if i > 0 && images_are_similar(&images[i - 1], &img, sticky_header_height) {
            tracing::info!(
                "Detected duplicate image at index {} - stopping stitch (page bottom reached)",
                i
            );
            // Clean up remaining temp files
            for remaining_path in image_paths.iter().skip(i) {
                let _ = std::fs::remove_file(remaining_path);
            }
            break;
        }

        images.push(img);
        unique_count += 1;
    }

    if images.is_empty() {
        return Err(("No valid images to stitch".to_string()).into());
    }

    // Load first image to get width
    let width = images[0].width();

    // Calculate actual content height per capture (excluding sticky header for images after first)
    let content_height_first = viewport_height;
    let content_height_rest = viewport_height.saturating_sub(sticky_header_height);

    // Calculate total output height based on actual unique images
    let num_images = unique_count as u32;
    let calculated_height = if num_images > 1 {
        content_height_first + (num_images - 1) * content_height_rest
    } else {
        content_height_first
    };
    // Use the smaller of calculated height and reported full height
    let output_height = calculated_height.min(full_height);

    // Create output image
    let mut output = RgbaImage::new(width, output_height);

    let mut y_offset = 0u32;

    for (i, img) in images.iter().enumerate() {
        // For first image, copy from top; for subsequent images, skip the sticky header
        let source_y_start = if i == 0 { 0 } else { sticky_header_height };
        let available_source_height = img.height().saturating_sub(source_y_start);

        // Calculate how much of this image to copy
        let remaining = output_height.saturating_sub(y_offset);
        let copy_height = remaining.min(available_source_height);

        // Copy pixels from source to output
        for y in 0..copy_height {
            for x in 0..width.min(img.width()) {
                let pixel = img.get_pixel(x, source_y_start + y);
                if y_offset + y < output_height {
                    output.put_pixel(x, y_offset + y, pixel);
                }
            }
        }

        y_offset += copy_height;

        // Clean up temp file
        let _ = std::fs::remove_file(&image_paths[i]);

        // Log progress for debugging
        tracing::debug!(
            "Stitched image {} of {}: copied {} rows (skipped {} header rows) at y_offset {}",
            i + 1,
            unique_count,
            copy_height,
            source_y_start,
            y_offset - copy_height
        );
    }

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let output_path = screenshots_dir.join(format!("fullpage-{timestamp}.png"));
    let output_path_str = output_path.to_string_lossy().to_string();

    // Save the stitched image
    output
        .save(&output_path)
        .map_err(|e| format!("Failed to save stitched image: {e}"))?;

    tracing::info!(
        "Full-page screenshot saved: {} ({}x{}, sticky header: {}px)",
        output_path_str,
        width,
        output_height,
        sticky_header_height
    );

    Ok(output_path_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(rgba)))
    }

    #[test]
    fn different_dimensions_are_not_similar() {
        let a = solid(100, 100, [0, 0, 0, 255]);
        let b = solid(100, 50, [0, 0, 0, 255]);
        assert!(!images_are_similar(&a, &b, 0));
    }

    #[test]
    fn identical_images_are_similar() {
        let a = solid(120, 120, [10, 20, 30, 255]);
        let b = solid(120, 120, [10, 20, 30, 255]);
        assert!(images_are_similar(&a, &b, 0));
    }

    #[test]
    fn within_compression_tolerance_is_similar() {
        // Each channel differs by 5 (< 10 threshold) -> still counts as matching.
        let a = solid(120, 120, [100, 100, 100, 255]);
        let b = solid(120, 120, [105, 105, 105, 255]);
        assert!(images_are_similar(&a, &b, 0));
    }

    #[test]
    fn beyond_tolerance_is_not_similar() {
        // Solid black vs solid white -> no sampled pixel matches.
        let a = solid(120, 120, [0, 0, 0, 255]);
        let b = solid(120, 120, [255, 255, 255, 255]);
        assert!(!images_are_similar(&a, &b, 0));
    }

    #[test]
    fn skip_header_still_samples_bottom_region() {
        // With a sticky-header skip, the comparison still runs over the bottom content region.
        let a = solid(120, 120, [50, 60, 70, 255]);
        let b = solid(120, 120, [50, 60, 70, 255]);
        assert!(images_are_similar(&a, &b, 40));
    }
}
