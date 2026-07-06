//! # Clipboard Commands
//!
//! Native clipboard access for the embedded terminals. On Windows, WebView2
//! gates keyboard-initiated textarea paste behind an async clipboard
//! permission wait, so Ctrl+V into a terminal takes ~30s or never lands
//! (issue #157). The frontend intercepts the chord and reads the clipboard
//! natively through these commands instead.
//!
//! `stage_clipboard_image` also enables pasting a clipboard image
//! (screenshot) into an agent terminal: the image is written to a temp PNG
//! and its path is pasted, mirroring the existing drag-drop behavior.

use crate::errors::CommandError;
use std::path::Path;

/// How many times to try opening/reading the clipboard. On Windows the
/// clipboard is a shared lock and can be transiently held by another app.
const CLIPBOARD_RETRY_ATTEMPTS: u32 = 3;
/// Delay between clipboard retry attempts.
const CLIPBOARD_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

/// Run a clipboard operation with a short retry loop.
///
/// `ContentNotAvailable` is returned immediately (the clipboard genuinely has
/// no content of the requested type — retrying won't change that); any other
/// error is retried up to [`CLIPBOARD_RETRY_ATTEMPTS`] times.
fn with_clipboard_retry<T>(
    mut op: impl FnMut(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    let mut last_err = arboard::Error::ContentNotAvailable;
    for attempt in 0..CLIPBOARD_RETRY_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(CLIPBOARD_RETRY_DELAY);
        }
        match arboard::Clipboard::new().and_then(|mut clipboard| op(&mut clipboard)) {
            Ok(value) => return Ok(value),
            Err(arboard::Error::ContentNotAvailable) => {
                return Err(arboard::Error::ContentNotAvailable)
            }
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

/// Read the system clipboard as text.
///
/// Returns `Ok(None)` when the clipboard holds no text (e.g. it's empty or
/// contains an image) rather than an error, so the frontend can fall through
/// to image handling.
#[tauri::command]
#[tracing::instrument]
pub fn read_clipboard_text() -> Result<Option<String>, CommandError> {
    match with_clipboard_retry(|clipboard| clipboard.get_text()) {
        Ok(text) => Ok(Some(text)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(err) => Err(CommandError::Other {
            message: format!("Failed to read clipboard text: {err}"),
        }),
    }
}

/// If the system clipboard holds an image, write it to a temp PNG and return
/// the absolute path (to be pasted into the terminal like a dropped file).
/// Returns `Ok(None)` when the clipboard holds no image.
#[tauri::command]
#[tracing::instrument]
pub fn stage_clipboard_image() -> Result<Option<String>, CommandError> {
    let image = match with_clipboard_retry(|clipboard| clipboard.get_image()) {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(err) => {
            return Err(CommandError::Other {
                message: format!("Failed to read clipboard image: {err}"),
            })
        }
    };

    let path = std::env::temp_dir().join(format!("shipstudio-paste-{}.png", uuid::Uuid::new_v4()));
    write_rgba_png(&path, image.width, image.height, &image.bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Encode a raw RGBA buffer as PNG and write it to `path`.
///
/// Pure helper so the encode+write step is unit-testable (arboard itself
/// can't run headless in CI).
fn write_rgba_png(
    path: &Path,
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<(), CommandError> {
    let expected_len = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| CommandError::Validation {
            field: "dimensions".to_string(),
            reason: format!("image dimensions overflow: {width}x{height}"),
        })?;
    if rgba.len() != expected_len {
        return Err(CommandError::Validation {
            field: "rgba".to_string(),
            reason: format!(
                "buffer length {} does not match {width}x{height} RGBA ({expected_len})",
                rgba.len()
            ),
        });
    }
    let (width_u32, height_u32) = (
        u32::try_from(width).map_err(|_| CommandError::Validation {
            field: "width".to_string(),
            reason: format!("width {width} exceeds u32"),
        })?,
        u32::try_from(height).map_err(|_| CommandError::Validation {
            field: "height".to_string(),
            reason: format!("height {height} exceeds u32"),
        })?,
    );
    let image =
        image::RgbaImage::from_raw(width_u32, height_u32, rgba.to_vec()).ok_or_else(|| {
            CommandError::Other {
                message: "Failed to construct image from clipboard RGBA buffer".to_string(),
            }
        })?;
    image
        .save_with_format(path, image::ImageFormat::Png)
        .map_err(|err| CommandError::Other {
            message: format!("Failed to encode clipboard image as PNG: {err}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_rgba_png_produces_a_decodable_png() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let path = dir.path().join("paste.png");

        // 2x2 image: red, green, blue, opaque white.
        #[rustfmt::skip]
        let rgba: [u8; 16] = [
            255, 0, 0, 255,
            0, 255, 0, 255,
            0, 0, 255, 255,
            255, 255, 255, 255,
        ];

        write_rgba_png(&path, 2, 2, &rgba).expect("write png");

        let decoded = image::open(&path).expect("decode png").into_rgba8();
        assert_eq!(decoded.dimensions(), (2, 2));
        assert_eq!(decoded.get_pixel(0, 0), &image::Rgba([255, 0, 0, 255]));
        assert_eq!(decoded.get_pixel(1, 0), &image::Rgba([0, 255, 0, 255]));
        assert_eq!(decoded.get_pixel(0, 1), &image::Rgba([0, 0, 255, 255]));
        assert_eq!(decoded.get_pixel(1, 1), &image::Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn write_rgba_png_rejects_mismatched_buffer_length() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let path = dir.path().join("bad.png");

        let err = write_rgba_png(&path, 2, 2, &[0u8; 4]).expect_err("should reject short buffer");
        assert!(matches!(err, CommandError::Validation { .. }));
        assert!(!path.exists());
    }
}
