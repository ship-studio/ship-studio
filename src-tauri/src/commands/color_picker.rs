//! Native screen colour sampling for the shared colour picker.
//!
//! WebKit does not expose the browser EyeDropper API, so macOS uses AppKit's
//! `NSColorSampler` instead. The availability check is runtime-based because
//! the app still supports macOS versions from before `NSColorSampler` was
//! introduced.

use crate::errors::CommandError;
use serde::Serialize;
use tauri::AppHandle;

#[cfg(not(target_os = "macos"))]
const NON_MACOS_UNAVAILABLE_REASON: &str =
    "This platform has no native screen colour sampler; the webview must provide the EyeDropper API.";

#[cfg(target_os = "macos")]
const MACOS_UNAVAILABLE_REASON: &str =
    "The native macOS screen colour sampler requires macOS 10.15 or later.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorSamplerSupport {
    pub available: bool,
    pub reason: Option<String>,
}

/// Report whether the native screen sampler can be used by the current OS.
///
/// The frontend also checks the webview's native `EyeDropper` implementation,
/// so a browser that supports that API remains usable on non-macOS platforms.
#[tauri::command]
#[tracing::instrument]
pub fn get_color_sampler_support() -> Result<ColorSamplerSupport, CommandError> {
    #[cfg(target_os = "macos")]
    {
        if macos_color_sampler_available() {
            Ok(ColorSamplerSupport {
                available: true,
                reason: None,
            })
        } else {
            Ok(ColorSamplerSupport {
                available: false,
                reason: Some(MACOS_UNAVAILABLE_REASON.to_string()),
            })
        }
    }

    #[cfg(not(target_os = "macos"))]
    Ok(ColorSamplerSupport {
        available: false,
        reason: Some(NON_MACOS_UNAVAILABLE_REASON.to_string()),
    })
}

/// Open the native sampler and return the selected colour as an sRGB hex
/// value. `None` means the user cancelled the sampler.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn sample_screen_color(app: AppHandle) -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "macos")]
    {
        return sample_macos_color(app).await;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(CommandError::expected(NON_MACOS_UNAVAILABLE_REASON))
    }
}

#[cfg(target_os = "macos")]
fn macos_color_sampler_available() -> bool {
    objc2::runtime::AnyClass::get("NSColorSampler").is_some()
}

#[cfg(target_os = "macos")]
type ColorSamplerResult = Result<Option<String>, String>;

#[cfg(target_os = "macos")]
static COLOR_SAMPLER_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
struct ColorSamplerSession;

#[cfg(target_os = "macos")]
impl ColorSamplerSession {
    fn begin() -> Result<Self, CommandError> {
        use std::sync::atomic::Ordering;

        COLOR_SAMPLER_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| CommandError::expected("The macOS colour sampler is already open"))
    }
}

#[cfg(target_os = "macos")]
impl Drop for ColorSamplerSession {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;

        COLOR_SAMPLER_ACTIVE.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
fn send_color_sampler_result(
    result_tx: &std::sync::Arc<
        std::sync::Mutex<Option<tokio::sync::oneshot::Sender<ColorSamplerResult>>>,
    >,
    result: ColorSamplerResult,
) {
    if let Ok(mut sender) = result_tx.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

#[cfg(target_os = "macos")]
async fn sample_macos_color(app: AppHandle) -> Result<Option<String>, CommandError> {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::oneshot;

    const SAMPLER_TIMEOUT_SECS: u64 = 300;
    const SAMPLER_SETTLE_MILLIS: u64 = 32;

    if !macos_color_sampler_available() {
        return Err(CommandError::expected(MACOS_UNAVAILABLE_REASON));
    }

    // AppKit creates a process-wide mouse-tracking session. Do not let rapid
    // clicks attach multiple callbacks to that session: competing global event
    // taps (notably QuickTime's "Show Mouse Clicks") make its teardown timing
    // especially sensitive.
    let _session = ColorSamplerSession::begin()?;

    let (result_tx, result_rx) = oneshot::channel::<ColorSamplerResult>();
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));
    let panic_tx = Arc::clone(&result_tx);

    app.run_on_main_thread(move || {
        let setup_tx = Arc::clone(&result_tx);
        let setup = catch_unwind(AssertUnwindSafe(move || {
            use objc2::msg_send;
            use objc2::rc::Retained;
            use objc2::runtime::{AnyClass, AnyObject};

            let Some(sampler_class) = AnyClass::get("NSColorSampler") else {
                send_color_sampler_result(&setup_tx, Err(MACOS_UNAVAILABLE_REASON.to_string()));
                return;
            };

            unsafe {
                let sampler_ptr: *mut AnyObject = msg_send![sampler_class, new];
                // SAFETY: Objective-C's `new` method family returns a +1 object.
                let Some(sampler) = Retained::from_raw(sampler_ptr) else {
                    send_color_sampler_result(
                        &setup_tx,
                        Err("AppKit could not create the macOS colour sampler".to_string()),
                    );
                    return;
                };

                let callback_tx = Arc::clone(&setup_tx);
                let selection_handler = block2::RcBlock::new(move |color: *mut AnyObject| {
                    // Objective-C callbacks must not unwind into AppKit.
                    let result = catch_unwind(AssertUnwindSafe(|| color_to_srgb_hex(color)))
                        .unwrap_or_else(|_| {
                            Err("Internal error while converting the sampled colour".to_string())
                        });

                    if let Err(error) = &result {
                        tracing::warn!(%error, "Failed to convert the sampled macOS colour");
                    }

                    send_color_sampler_result(&callback_tx, result);
                });

                // `showSamplerWithSelectionHandler:` retains the block until the user
                // selects a colour or cancels with Escape. AppKit also retains the sampler
                // for the session, so let our +1 ownership go out of scope after `show`
                // returns instead of releasing it re-entrantly from its own callback.
                let _: () =
                    msg_send![&*sampler, showSamplerWithSelectionHandler: &*selection_handler];
            }
        }));

        if setup.is_err() {
            send_color_sampler_result(
                &panic_tx,
                Err("Internal error while opening the macOS colour sampler".to_string()),
            );
        }
    })
    .map_err(|error| {
        CommandError::from(format!("Could not open the macOS colour sampler: {error}"))
    })?;

    let result =
        match tokio::time::timeout(Duration::from_secs(SAMPLER_TIMEOUT_SECS), result_rx).await {
            Ok(Ok(Ok(color))) => Ok(color),
            Ok(Ok(Err(message))) => Err(CommandError::from(message)),
            Ok(Err(_)) => Err(CommandError::from(
                "The macOS colour sampler closed without returning a result",
            )),
            Err(_) => Err(CommandError::expected(
                "The macOS colour sampler timed out before a colour was selected",
            )),
        };

    // The callback runs inside AppKit's mouse event handling. Keep the result
    // away from the webview for two frames so AppKit can tear down its global
    // tracking session before React updates or refocuses the picker window.
    tokio::time::sleep(Duration::from_millis(SAMPLER_SETTLE_MILLIS)).await;
    result
}

/// Convert the `NSColor` supplied by AppKit into the same sRGB hex format as
/// the browser EyeDropper API.
///
/// # Safety
/// The pointer must be the `NSColor*` delivered by the sampler callback, and
/// this function must run on the AppKit main thread.
#[cfg(target_os = "macos")]
unsafe fn color_to_srgb_hex(color: *mut objc2::runtime::AnyObject) -> ColorSamplerResult {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    if color.is_null() {
        return Ok(None);
    }

    let color_space: *mut AnyObject = msg_send![class!(NSColorSpace), sRGBColorSpace];
    if color_space.is_null() {
        return Err("AppKit could not create the sRGB colour space".to_string());
    }

    let srgb_color: *mut AnyObject = msg_send![color, colorUsingColorSpace: &*color_space];
    if srgb_color.is_null() {
        return Err("AppKit could not convert the sampled colour to sRGB".to_string());
    }

    // `colorUsingColorSpace:` guarantees an RGB color here. The scalar
    // accessors avoid passing `CGFloat*` values through the untyped message
    // boundary, which can otherwise reject a perfectly valid sampled color.
    let red: f64 = msg_send![srgb_color, redComponent];
    let green: f64 = msg_send![srgb_color, greenComponent];
    let blue: f64 = msg_send![srgb_color, blueComponent];
    if ![red, green, blue]
        .iter()
        .all(|component| component.is_finite())
    {
        return Err("AppKit returned invalid sampled colour components".to_string());
    }

    let to_byte = |component: f64| (component.clamp(0.0, 1.0) * 255.0).round() as u8;
    Ok(Some(format!(
        "#{:02X}{:02X}{:02X}",
        to_byte(red),
        to_byte(green),
        to_byte(blue)
    )))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::color_to_srgb_hex;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    #[test]
    fn converts_an_srgb_appkit_color_to_hex() {
        let color: *mut AnyObject = unsafe {
            msg_send![
                class!(NSColor),
                colorWithSRGBRed: 0.1_f64
                green: 0.5_f64
                blue: 0.9_f64
                alpha: 1.0_f64
            ]
        };

        assert!(!color.is_null());
        assert_eq!(
            unsafe { color_to_srgb_hex(color) }.unwrap(),
            Some("#1A80E6".to_string())
        );
    }
}
