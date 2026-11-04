//! Dictation: on-device Apple speech recognition, streamed to the webview.
//!
//! Why native rather than the webview's `webkitSpeechRecognition`: the
//! constructor exists in WKWebView, but whether it produces results inside an
//! app (as opposed to Safari) can't be proven without starting recognition,
//! and even when it works it gives no on-device guarantee, no vocabulary hints,
//! no audio level, and stops when the window isn't frontmost. Voice mode needs
//! all four. See docs/agents-roadmap.md, "Voice".
//!
//! Shape: `start_dictation` asks for permission if needed and starts one
//! session; everything after that arrives as `dictation://event` events
//! (`partial`, `final`, `level`, `error`, then always exactly one `ended`).
//! `stop_dictation` stops the microphone and lets the recognizer finish the
//! last words; `cancel_dictation` throws the session away.
//!
//! Threading: every AppKit/Speech object lives on the main thread in
//! `SESSION`. The recognizer delivers results on the main queue. Only the
//! audio tap runs elsewhere (the audio I/O thread); it touches nothing but the
//! request it captured and the event emitter.

use crate::errors::CommandError;
use serde::Serialize;
use tauri::AppHandle;

/// The one event channel. Payload: [`DictationEvent`].
pub const DICTATION_EVENT: &str = "dictation://event";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Granted,
    Denied,
    Restricted,
    NotDetermined,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// A recognizer exists for this Mac's language and is usable right now.
    pub supported: bool,
    /// Why `supported` is false, in a sentence the UI can show.
    pub reason: Option<String>,
    pub microphone: Permission,
    pub speech_recognition: Permission,
    /// Recognition runs on this Mac (audio never leaves it).
    pub on_device: bool,
    pub locale: Option<String>,
}

/// Why a start didn't become a session. Not an error: each is a state the
/// UI explains.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DictationBlock {
    Microphone,
    SpeechRecognition,
    Unavailable,
    /// The running binary has no usage-description strings, so macOS would
    /// kill it on the permission request. Seen only in a misconfigured build.
    MissingUsageDescription,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DictationStart {
    Listening { session: u64 },
    Blocked { reason: DictationBlock },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DictationEvent {
    /// The whole transcript so far (not a delta); earlier words may change.
    Partial {
        session: u64,
        text: String,
    },
    Final {
        session: u64,
        text: String,
    },
    /// Input loudness, 0..1, about fifteen times a second.
    Level {
        session: u64,
        level: f32,
    },
    Error {
        session: u64,
        message: String,
    },
    Ended {
        session: u64,
        cancelled: bool,
    },
}

/// Map an RMS amplitude to 0..1 over a -50 dB..0 dB window, which is roughly
/// "room tone" to "talking close to the mic".
pub fn level_from_rms(rms: f32) -> f32 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db + 50.0) / 50.0).clamp(0.0, 1.0)
}

/// Vocabulary hints are cheap but not free; keep the list bounded.
pub fn clean_contextual_strings(strings: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in strings {
        let s = s.trim();
        if s.is_empty() || s.chars().count() > 64 || out.iter().any(|o| o == s) {
            continue;
        }
        out.push(s.to_string());
        if out.len() == 100 {
            break;
        }
    }
    out
}

#[tauri::command]
#[tracing::instrument]
pub fn get_dictation_status() -> Result<DictationStatus, CommandError> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos::status())
    }
    #[cfg(not(target_os = "macos"))]
    Ok(DictationStatus {
        supported: false,
        reason: Some("Dictation is only available on macOS for now.".into()),
        microphone: Permission::NotDetermined,
        speech_recognition: Permission::NotDetermined,
        on_device: false,
        locale: None,
    })
}

/// Start listening. Prompts for microphone and speech-recognition access the
/// first time; a denied permission comes back as `Blocked`, not an error.
#[tauri::command]
#[tracing::instrument(skip(app, contextual_strings))]
pub async fn start_dictation(
    app: AppHandle,
    contextual_strings: Option<Vec<String>>,
) -> Result<DictationStart, CommandError> {
    #[cfg(target_os = "macos")]
    {
        macos::start(
            app,
            clean_contextual_strings(contextual_strings.unwrap_or_default()),
        )
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, contextual_strings);
        Ok(DictationStart::Blocked {
            reason: DictationBlock::Unavailable,
        })
    }
}

/// Stop the microphone and let the recognizer finish. The final text arrives
/// as a `final` event, then `ended`.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub fn stop_dictation(app: AppHandle, session: u64) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        macos::stop(app, session)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
        Ok(())
    }
}

/// Discard the session: no final text, `ended` with `cancelled: true`.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub fn cancel_dictation(app: AppHandle, session: u64) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        macos::cancel(app, session)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use std::cell::{Cell, RefCell};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::Emitter;
    use tokio::sync::oneshot;

    #[link(name = "Speech", kind = "framework")]
    extern "C" {}
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    /// `SFSpeechRecognitionTaskHintDictation`.
    const TASK_HINT_DICTATION: isize = 1;
    /// How long a stopped session may take to deliver its final text.
    const FINISH_TIMEOUT: Duration = Duration::from_secs(3);
    /// Level events per second.
    const LEVELS_PER_SECOND: f64 = 15.0;

    static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

    struct Session {
        id: u64,
        engine: Retained<AnyObject>,
        request: Retained<AnyObject>,
        task: Option<Retained<AnyObject>>,
        capturing: bool,
    }

    thread_local! {
        /// Main thread only.
        static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    }

    fn emit(app: &AppHandle, event: DictationEvent) {
        if let Err(error) = app.emit(DICTATION_EVENT, event) {
            tracing::warn!(%error, "Failed to emit dictation event");
        }
    }

    fn mic_permission(raw: isize) -> Permission {
        // AVAuthorizationStatus
        match raw {
            3 => Permission::Granted,
            2 => Permission::Denied,
            1 => Permission::Restricted,
            _ => Permission::NotDetermined,
        }
    }

    fn speech_permission(raw: isize) -> Permission {
        // SFSpeechRecognizerAuthorizationStatus (a different order)
        match raw {
            3 => Permission::Granted,
            1 => Permission::Denied,
            2 => Permission::Restricted,
            _ => Permission::NotDetermined,
        }
    }

    fn mic_status() -> Permission {
        let Some(cls) = AnyClass::get("AVCaptureDevice") else {
            return Permission::NotDetermined;
        };
        let raw: isize =
            unsafe { msg_send![cls, authorizationStatusForMediaType: AVMediaTypeAudio] };
        mic_permission(raw)
    }

    fn speech_status() -> Permission {
        let Some(cls) = AnyClass::get("SFSpeechRecognizer") else {
            return Permission::NotDetermined;
        };
        let raw: isize = unsafe { msg_send![cls, authorizationStatus] };
        speech_permission(raw)
    }

    /// `[[SFSpeechRecognizer alloc] init]`: the recognizer for the user's
    /// language, or `None` if that language isn't supported.
    fn recognizer() -> Option<Retained<AnyObject>> {
        let cls = AnyClass::get("SFSpeechRecognizer")?;
        unsafe {
            let alloc: *mut AnyObject = msg_send![cls, alloc];
            let obj: *mut AnyObject = msg_send![alloc, init];
            Retained::from_raw(obj)
        }
    }

    fn ns_to_string(obj: *mut AnyObject) -> Option<String> {
        if obj.is_null() {
            return None;
        }
        // SAFETY: callers pass an NSString*.
        Some(unsafe { &*(obj as *const NSString) }.to_string())
    }

    fn has_usage_descriptions() -> bool {
        unsafe {
            let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
            if bundle.is_null() {
                return false;
            }
            [
                "NSMicrophoneUsageDescription",
                "NSSpeechRecognitionUsageDescription",
            ]
            .iter()
            .all(|key| {
                let key = NSString::from_str(key);
                let value: *mut AnyObject = msg_send![bundle, objectForInfoDictionaryKey: &*key];
                !value.is_null()
            })
        }
    }

    /// Read-only: never prompts.
    pub fn status() -> DictationStatus {
        let microphone = mic_status();
        let speech_recognition = speech_status();
        let Some(rec) = recognizer() else {
            return DictationStatus {
                supported: false,
                reason: Some("Speech recognition doesn't support this Mac's language.".into()),
                microphone,
                speech_recognition,
                on_device: false,
                locale: None,
            };
        };
        unsafe {
            let available: bool = msg_send![&*rec, isAvailable];
            let on_device: bool = msg_send![&*rec, supportsOnDeviceRecognition];
            let locale: *mut AnyObject = msg_send![&*rec, locale];
            let locale = if locale.is_null() {
                None
            } else {
                let id: *mut AnyObject = msg_send![locale, localeIdentifier];
                ns_to_string(id)
            };
            DictationStatus {
                supported: available,
                reason: (!available)
                    .then(|| "Speech recognition isn't available right now.".into()),
                microphone,
                speech_recognition,
                on_device,
                locale,
            }
        }
    }

    type Reply<T> = Arc<Mutex<Option<oneshot::Sender<T>>>>;

    fn reply<T>(tx: &Reply<T>, value: T) {
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(value);
        }
    }

    async fn request_mic() -> Permission {
        let (tx, rx) = oneshot::channel::<bool>();
        let tx: Reply<bool> = Arc::new(Mutex::new(Some(tx)));
        let Some(cls) = AnyClass::get("AVCaptureDevice") else {
            return Permission::NotDetermined;
        };
        {
            // ObjC copies the block; ours must drop before the await (not Send).
            let handler = block2::RcBlock::new(move |granted: Bool| reply(&tx, granted.as_bool()));
            unsafe {
                let _: () = msg_send![
                    cls,
                    requestAccessForMediaType: AVMediaTypeAudio,
                    completionHandler: &*handler
                ];
            }
        }
        match rx.await {
            Ok(true) => Permission::Granted,
            _ => mic_status(),
        }
    }

    async fn request_speech() -> Permission {
        let (tx, rx) = oneshot::channel::<isize>();
        let tx: Reply<isize> = Arc::new(Mutex::new(Some(tx)));
        let Some(cls) = AnyClass::get("SFSpeechRecognizer") else {
            return Permission::NotDetermined;
        };
        {
            let handler = block2::RcBlock::new(move |status: isize| reply(&tx, status));
            unsafe {
                let _: () = msg_send![cls, requestAuthorization: &*handler];
            }
        }
        rx.await
            .map(speech_permission)
            .unwrap_or_else(|_| speech_status())
    }

    pub async fn start(
        app: AppHandle,
        contextual: Vec<String>,
    ) -> Result<DictationStart, CommandError> {
        let blocked = |reason| Ok(DictationStart::Blocked { reason });
        let st = status();
        if !st.supported {
            return blocked(DictationBlock::Unavailable);
        }
        // Asking without the Info.plist strings makes macOS kill the process.
        let needs_prompt = st.microphone == Permission::NotDetermined
            || st.speech_recognition == Permission::NotDetermined;
        if needs_prompt && !has_usage_descriptions() {
            return blocked(DictationBlock::MissingUsageDescription);
        }

        let mic = match st.microphone {
            Permission::NotDetermined => request_mic().await,
            p => p,
        };
        if mic != Permission::Granted {
            return blocked(DictationBlock::Microphone);
        }
        let speech = match st.speech_recognition {
            Permission::NotDetermined => request_speech().await,
            p => p,
        };
        if speech != Permission::Granted {
            return blocked(DictationBlock::SpeechRecognition);
        }

        let (tx, rx) = oneshot::channel::<Result<u64, String>>();
        let tx: Reply<Result<u64, String>> = Arc::new(Mutex::new(Some(tx)));
        let panic_tx = Arc::clone(&tx);
        let main_app = app.clone();
        app.run_on_main_thread(move || {
            let result = catch_unwind(AssertUnwindSafe(|| begin(&main_app, &contextual)))
                .unwrap_or_else(|_| Err("Internal error while starting dictation".into()));
            reply(&panic_tx, result);
        })
        .map_err(|e| CommandError::from(format!("Could not start dictation: {e}")))?;
        drop(tx);

        match rx.await {
            Ok(Ok(session)) => Ok(DictationStart::Listening { session }),
            Ok(Err(message)) => Err(CommandError::expected(message)),
            Err(_) => Err(CommandError::from("Dictation didn't start")),
        }
    }

    /// Main thread. Builds the request, starts the microphone, starts the
    /// recognition task.
    fn begin(app: &AppHandle, contextual: &[String]) -> Result<u64, String> {
        // One session at a time: a new start replaces any old one.
        if let Some(old) = SESSION.with(|s| s.borrow_mut().take()) {
            teardown(app, old, true);
        }

        let rec = recognizer().ok_or("Speech recognition doesn't support this Mac's language.")?;
        let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);

        unsafe {
            let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
            let _: () = msg_send![&*rec, setQueue: queue];

            let request_cls = AnyClass::get("SFSpeechAudioBufferRecognitionRequest")
                .ok_or("Speech recognition isn't available on this Mac.")?;
            let request: Retained<AnyObject> = Retained::from_raw(msg_send![request_cls, new])
                .ok_or("Couldn't create a request")?;
            let _: () = msg_send![&*request, setShouldReportPartialResults: true];
            let _: () = msg_send![&*request, setTaskHint: TASK_HINT_DICTATION];
            let on_device: bool = msg_send![&*rec, supportsOnDeviceRecognition];
            if on_device {
                let _: () = msg_send![&*request, setRequiresOnDeviceRecognition: true];
            }
            let punct: bool = msg_send![&*request, respondsToSelector: sel!(setAddsPunctuation:)];
            if punct {
                let _: () = msg_send![&*request, setAddsPunctuation: true];
            }
            if !contextual.is_empty() {
                let array: Retained<AnyObject> =
                    Retained::from_raw(msg_send![class!(NSMutableArray), new])
                        .ok_or("Couldn't create a list")?;
                for s in contextual {
                    let s = NSString::from_str(s);
                    let _: () = msg_send![&*array, addObject: &*s];
                }
                let _: () = msg_send![&*request, setContextualStrings: &*array];
            }

            let engine_cls =
                AnyClass::get("AVAudioEngine").ok_or("Audio capture isn't available")?;
            let engine: Retained<AnyObject> =
                Retained::from_raw(msg_send![engine_cls, new]).ok_or("Couldn't open audio")?;
            let input: *mut AnyObject = msg_send![&*engine, inputNode];
            if input.is_null() {
                return Err("No microphone found.".into());
            }
            let format: *mut AnyObject = msg_send![input, outputFormatForBus: 0usize];
            let sample_rate: f64 = if format.is_null() {
                0.0
            } else {
                msg_send![format, sampleRate]
            };
            if sample_rate <= 0.0 {
                return Err("No microphone found.".into());
            }

            // Audio I/O thread. Feeds the recognizer and reports loudness.
            let tap_request = request.clone();
            let tap_app = app.clone();
            let frames_per_level = (sample_rate / LEVELS_PER_SECOND) as u64;
            let frames = Cell::new(0u64);
            let peak = Cell::new(0f32);
            let tap = block2::RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
                if buffer.is_null() {
                    return;
                }
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    objc2::rc::autoreleasepool(|_| {
                        let _: () = msg_send![&*tap_request, appendAudioPCMBuffer: buffer];
                        let len: u32 = msg_send![buffer, frameLength];
                        let channels: *const *const f32 = msg_send![buffer, floatChannelData];
                        if channels.is_null() || len == 0 {
                            return;
                        }
                        let samples = std::slice::from_raw_parts(*channels, len as usize);
                        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / len as f32).sqrt();
                        peak.set(peak.get().max(level_from_rms(rms)));
                        frames.set(frames.get() + len as u64);
                        if frames.get() >= frames_per_level {
                            emit(
                                &tap_app,
                                DictationEvent::Level {
                                    session: id,
                                    level: peak.get(),
                                },
                            );
                            frames.set(0);
                            peak.set(0.0);
                        }
                    });
                }));
            });
            let _: () = msg_send![
                input,
                installTapOnBus: 0usize,
                bufferSize: 1024u32,
                format: format,
                block: &*tap
            ];
            let _: () = msg_send![&*engine, prepare];
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let started: bool = msg_send![&*engine, startAndReturnError: &mut err];
            if !started {
                let _: () = msg_send![input, removeTapOnBus: 0usize];
                let desc = if err.is_null() {
                    None
                } else {
                    ns_to_string(msg_send![err, localizedDescription])
                };
                return Err(desc.unwrap_or_else(|| "The microphone couldn't start.".into()));
            }

            // Main queue (set above).
            let result_app = app.clone();
            let handler =
                block2::RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        on_result(&result_app, id, result, error)
                    }));
                });
            let task: *mut AnyObject = msg_send![
                &*rec,
                recognitionTaskWithRequest: &*request,
                resultHandler: &*handler
            ];
            let task = Retained::retain(task);

            SESSION.with(|s| {
                *s.borrow_mut() = Some(Session {
                    id,
                    engine,
                    request,
                    task,
                    capturing: true,
                })
            });
        }
        Ok(id)
    }

    /// `kAFAssistantErrorDomain` 1110 is "no speech detected"; 216 and
    /// `kLSRErrorDomain` 301 are our own cancel/stop. None is worth showing.
    fn is_benign(code: isize) -> bool {
        matches!(code, 1110 | 216 | 301 | 203)
    }

    /// Main thread (the recognizer's queue).
    fn on_result(app: &AppHandle, id: u64, result: *mut AnyObject, error: *mut AnyObject) {
        let current = SESSION.with(|s| s.try_borrow().ok().and_then(|s| s.as_ref().map(|s| s.id)));
        if current != Some(id) {
            return;
        }
        let mut done = false;
        unsafe {
            if !result.is_null() {
                let best: *mut AnyObject = msg_send![result, bestTranscription];
                let text = if best.is_null() {
                    None
                } else {
                    ns_to_string(msg_send![best, formattedString])
                }
                .unwrap_or_default();
                let is_final: bool = msg_send![result, isFinal];
                if is_final {
                    emit(app, DictationEvent::Final { session: id, text });
                    done = true;
                } else {
                    emit(app, DictationEvent::Partial { session: id, text });
                }
            }
            if !error.is_null() {
                let code: isize = msg_send![error, code];
                if !is_benign(code) {
                    let message = ns_to_string(msg_send![error, localizedDescription])
                        .unwrap_or_else(|| "Dictation stopped unexpectedly.".into());
                    tracing::warn!(code, %message, "Dictation error");
                    emit(
                        app,
                        DictationEvent::Error {
                            session: id,
                            message,
                        },
                    );
                }
                done = true;
            }
        }
        if done {
            if let Some(session) = SESSION.with(|s| s.borrow_mut().take()) {
                teardown(app, session, false);
            }
        }
    }

    unsafe fn stop_capture(session: &mut Session) {
        if !session.capturing {
            return;
        }
        session.capturing = false;
        let _: () = msg_send![&*session.engine, stop];
        let input: *mut AnyObject = msg_send![&*session.engine, inputNode];
        if !input.is_null() {
            let _: () = msg_send![input, removeTapOnBus: 0usize];
        }
        let _: () = msg_send![&*session.request, endAudio];
    }

    /// Main thread. The session must already be out of `SESSION`, because
    /// `cancel` can call the result handler re-entrantly.
    fn teardown(app: &AppHandle, mut session: Session, cancelled: bool) {
        unsafe {
            stop_capture(&mut session);
            if cancelled {
                if let Some(task) = &session.task {
                    let _: () = msg_send![&**task, cancel];
                }
            }
        }
        emit(
            app,
            DictationEvent::Ended {
                session: session.id,
                cancelled,
            },
        );
    }

    fn on_main(
        app: &AppHandle,
        f: impl FnOnce(&AppHandle) + Send + 'static,
    ) -> Result<(), CommandError> {
        let main_app = app.clone();
        app.run_on_main_thread(move || {
            let _ = catch_unwind(AssertUnwindSafe(|| f(&main_app)));
        })
        .map_err(|e| CommandError::from(format!("Dictation: {e}")))
    }

    pub fn stop(app: AppHandle, session: u64) -> Result<(), CommandError> {
        on_main(&app, move |app| {
            SESSION.with(|s| {
                if let Some(current) = s.borrow_mut().as_mut().filter(|c| c.id == session) {
                    unsafe { stop_capture(current) };
                }
            });
            // The final result normally lands well inside this.
            let timeout_app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FINISH_TIMEOUT).await;
                let _ = cancel(timeout_app, session);
            });
        })
    }

    pub fn cancel(app: AppHandle, session: u64) -> Result<(), CommandError> {
        on_main(&app, move |app| {
            let taken = SESSION.with(|s| {
                let mut s = s.borrow_mut();
                if s.as_ref().map(|c| c.id) == Some(session) {
                    s.take()
                } else {
                    None
                }
            });
            if let Some(current) = taken {
                teardown(app, current, true);
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_maps_decibels_to_unit_range() {
        assert_eq!(level_from_rms(0.0), 0.0);
        assert_eq!(level_from_rms(f32::NAN), 0.0);
        assert_eq!(level_from_rms(1.0), 1.0);
        assert!((level_from_rms(0.01) - 0.2).abs() < 0.01); // -40 dB
        assert_eq!(level_from_rms(0.000_01), 0.0); // -100 dB clamps
    }

    #[test]
    fn contextual_strings_are_trimmed_deduped_and_bounded() {
        let long = "x".repeat(65);
        let cleaned = clean_contextual_strings(vec![
            " Chief of Staff ".into(),
            "Chief of Staff".into(),
            "".into(),
            long,
            "Acme Site".into(),
        ]);
        assert_eq!(cleaned, vec!["Chief of Staff", "Acme Site"]);
        let many = (0..150).map(|i| format!("agent {i}")).collect();
        assert_eq!(clean_contextual_strings(many).len(), 100);
    }

    #[test]
    fn events_serialize_with_kind_tag() {
        let json = serde_json::to_value(DictationEvent::Partial {
            session: 3,
            text: "hi".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "partial");
        assert_eq!(json["session"], 3);
        let start = serde_json::to_value(DictationStart::Blocked {
            reason: DictationBlock::SpeechRecognition,
        })
        .unwrap();
        assert_eq!(start["status"], "blocked");
        assert_eq!(start["reason"], "speechRecognition");
    }
}
