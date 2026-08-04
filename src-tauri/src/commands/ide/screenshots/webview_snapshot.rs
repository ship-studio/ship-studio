//! Native in-app thumbnail capture: snapshot the preview region of the app's
//! own webview instead of spawning a headless browser.
//!
//! Why: every recurring thumbnail failure class — Chromium SingletonLock
//! collisions (#358 + ~70 duplicates), crashpad pipe races (#421/#422),
//! updater/GCM noise (#498–#500), silent exit-0 captures (#526), orphaned
//! timed-out processes (#510), "no browser installed" — comes from shelling
//! out to an external browser to re-render a page the app is *already
//! displaying*. Snapshotting our own webview has none of those failure modes,
//! needs no Screen Recording permission (it renders in-process, unlike the
//! `screencapture` path), and costs no per-capture browser launch.
//!
//! macOS-only for now (`WKWebView takeSnapshot`). Other platforms return an
//! Expected error so the frontend silently falls back to the headless path;
//! Windows can follow via WebView2 `CapturePreview`.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::Deserialize;

use super::thumbnail::{is_thumbnail_locked, CaptureClaim};

/// The preview pane's on-screen rectangle in CSS pixels, relative to the
/// webview's top-left — exactly what `getBoundingClientRect()` reports.
/// WKWebView is a flipped view, so its snapshot coordinate space matches.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SnapshotRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl SnapshotRect {
    fn validate(&self) -> Result<(), CommandError> {
        let finite = [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite());
        if !finite || self.width < 50.0 || self.height < 50.0 {
            return Err(CommandError::expected(format!(
                "Preview region too small or invalid for a thumbnail snapshot ({}x{})",
                self.width, self.height
            )));
        }
        Ok(())
    }
}

/// Capture the preview region of the calling window's webview and save it as
/// the project thumbnail. Returns the thumbnail path, mirroring
/// `capture_project_thumbnail` so callers can treat the two paths uniformly.
#[tauri::command]
#[tracing::instrument(skip(webview_window), fields(project = %project_path))]
pub async fn capture_thumbnail_from_webview(
    webview_window: tauri::WebviewWindow,
    project_path: String,
    rect: SnapshotRect,
) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;
    rect.validate()?;

    // Same claim as the headless path — both write the same thumbnail.png,
    // and a native snapshot racing a slow headless capture must not
    // interleave writes.
    let Some(_claim) = CaptureClaim::try_new(&project) else {
        return Err(CommandError::expected(
            "A thumbnail capture for this project is already in progress",
        ));
    };

    if is_thumbnail_locked(&project) {
        let thumbnail_path = project.join(".shipstudio").join("thumbnail.png");
        tracing::info!("Skipping native snapshot; custom thumbnail in place");
        return Ok(thumbnail_path.to_string_lossy().to_string());
    }

    let png_bytes = snapshot_webview_region(&webview_window, rect).await?;

    let shipstudio_dir = project.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }
    let thumbnail_path = shipstudio_dir.join("thumbnail.png");
    std::fs::write(&thumbnail_path, &png_bytes)
        .map_err(|e| format!("Failed to write thumbnail: {e}"))?;
    // A Retina snapshot comes back at 2x pixels; normalize to the same 640px
    // width the headless path produces so the dashboard renders consistently.
    crate::commands::ide::resize_thumbnail_image(&thumbnail_path, 640);

    tracing::info!("Thumbnail captured via native webview snapshot");
    Ok(thumbnail_path.to_string_lossy().to_string())
}

#[cfg(target_os = "macos")]
async fn snapshot_webview_region(
    webview_window: &tauri::WebviewWindow,
    rect: SnapshotRect,
) -> Result<Vec<u8>, CommandError> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{CGPoint, CGRect, CGSize};

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<Vec<u8>, String>>();

    webview_window
        .with_webview(move |webview| {
            // Runs on the main thread. All Obj-C work happens here; only the
            // finished PNG bytes cross back to the async command.
            let wk: *mut AnyObject = webview.inner().cast();
            if wk.is_null() {
                let _ = tx.send(Err("webview handle is null".to_string()));
                return;
            }
            unsafe {
                let config: *mut AnyObject = msg_send![class!(WKSnapshotConfiguration), new];
                let cg_rect = CGRect {
                    origin: CGPoint {
                        x: rect.x,
                        y: rect.y,
                    },
                    size: CGSize {
                        width: rect.width,
                        height: rect.height,
                    },
                };
                let _: () = msg_send![config, setRect: cg_rect];
                // Ask WebKit to hand back a pre-scaled image: 640pt wide, the
                // dashboard thumbnail size. (Retina still doubles the pixels;
                // resize_thumbnail_image normalizes after the write.)
                let width_num: *mut AnyObject =
                    msg_send![class!(NSNumber), numberWithDouble: 640.0f64];
                let _: () = msg_send![config, setSnapshotWidth: width_num];

                let block = block2::RcBlock::new(
                    move |image: *mut AnyObject, error: *mut AnyObject| {
                        // A panic here unwinds across the Objective-C block
                        // boundary and aborts the entire app — degrade any
                        // internal error to a failed capture instead.
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                            || png_bytes_from_snapshot(image, error),
                        ))
                        .unwrap_or_else(|_| {
                            Err("internal panic during snapshot conversion".to_string())
                        });
                        let _ = tx.send(result);
                    },
                );
                let _: () = msg_send![wk, takeSnapshotWithConfiguration: config, completionHandler: &*block];
                let _: () = msg_send![config, release];
            }
        })
        .map_err(|e| CommandError::from(format!("Could not reach the app webview: {e}")))?;

    // WebKit renders snapshots in-process off the live layer tree — normally
    // milliseconds. The ceiling only guards a wedged web process.
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await {
        Ok(Some(Ok(bytes))) => Ok(bytes),
        Ok(Some(Err(message))) => Err(CommandError::from(format!(
            "Webview snapshot failed: {message}"
        ))),
        Ok(None) => Err(CommandError::from(
            "Webview snapshot callback dropped without a result".to_string(),
        )),
        Err(_) => Err(CommandError::from(
            "Webview snapshot timed out after 10s".to_string(),
        )),
    }
}

/// Convert the `takeSnapshot` completion values into PNG bytes.
///
/// # Safety
/// Must be called with the (possibly null) `NSImage*` / `NSError*` pointers
/// exactly as delivered by WebKit's completion handler, on the main thread.
#[cfg(target_os = "macos")]
unsafe fn png_bytes_from_snapshot(
    image: *mut objc2::runtime::AnyObject,
    error: *mut objc2::runtime::AnyObject,
) -> Result<Vec<u8>, String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    if image.is_null() {
        if error.is_null() {
            return Err("snapshot returned neither image nor error".to_string());
        }
        let desc: *mut AnyObject = msg_send![error, localizedDescription];
        if desc.is_null() {
            return Err("snapshot failed with an undescribed error".to_string());
        }
        let utf8: *const std::os::raw::c_char = msg_send![desc, UTF8String];
        if utf8.is_null() {
            return Err("snapshot failed with an undescribed error".to_string());
        }
        return Err(std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned());
    }

    let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
    if tiff.is_null() {
        return Err("snapshot image produced no TIFF data".to_string());
    }
    let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
    if rep.is_null() {
        return Err("could not decode snapshot bitmap".to_string());
    }
    let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
    // 4 == NSBitmapImageFileTypePNG
    let png: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: props];
    if png.is_null() {
        return Err("PNG encoding of the snapshot failed".to_string());
    }
    // NB: -[NSData bytes] returns `const void *` (objc type code `^v`) — typing
    // this as `*const u8` (code `*`) trips objc2's encoding verification and
    // panics in debug builds.
    let bytes: *const std::ffi::c_void = msg_send![png, bytes];
    let len: usize = msg_send![png, length];
    if bytes.is_null() || len == 0 {
        return Err("PNG encoding produced empty data".to_string());
    }
    Ok(std::slice::from_raw_parts(bytes.cast::<u8>(), len).to_vec())
}

#[cfg(not(target_os = "macos"))]
async fn snapshot_webview_region(
    _webview_window: &tauri::WebviewWindow,
    _rect: SnapshotRect,
) -> Result<Vec<u8>, CommandError> {
    // Expected: the frontend probes this path first on every platform and
    // falls back to the headless capture when it isn't available.
    Err(CommandError::expected(
        "Native webview snapshot is not supported on this platform yet",
    ))
}

#[cfg(test)]
mod rect_tests {
    use super::*;

    #[test]
    fn tiny_or_invalid_rects_are_rejected_as_expected() {
        let too_small = SnapshotRect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 300.0,
        };
        assert!(matches!(
            too_small.validate(),
            Err(CommandError::Expected { .. })
        ));

        let nan = SnapshotRect {
            x: f64::NAN,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(nan.validate().is_err());
    }

    #[test]
    fn normal_preview_rect_passes() {
        let rect = SnapshotRect {
            x: 320.5,
            y: 48.0,
            width: 900.0,
            height: 640.0,
        };
        assert!(rect.validate().is_ok());
    }
}
