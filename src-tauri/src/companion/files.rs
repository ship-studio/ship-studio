//! The HTTP side of files: uploads in, blobs and attachments out.
//!
//! Every route takes `Authorization: Bearer <token>`, checked against the
//! registry like the socket's hello. An unknown or revoked token gets a bare
//! 401; anything the caller may not see (another device's blob, a path
//! outside the agent's attachments) is a bare 404, so a probe learns nothing.

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::{header, HeaderMap, Method, Request, Response, StatusCode};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::server::{body, json_response, status_only, Body};
use super::wire::{RouteKind, WireError};
use super::{now_ms, Auth, Companion, DeviceRecord};
use crate::agents::attachments::{mime_for, MAX_FILE_BYTES};

/// An upload has this long to arrive in full: 25 MB over a slow cellular
/// link, with room to spare.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Thumbnails are at most this wide (`?w=` above it is clamped).
pub const MAX_THUMB_WIDTH: u32 = 1024;
const MIN_THUMB_WIDTH: u32 = 16;

/// The device behind the request's bearer token, if any.
fn authorize(c: &Companion, headers: &HeaderMap) -> Option<DeviceRecord> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.trim().is_empty() {
        return None;
    }
    match c.registry.authenticate(token.trim()) {
        Auth::Device(d) => {
            c.registry
                .touch(&d.id, now_ms() as i64, RouteKind::Tailscale, false);
            Some(d)
        }
        Auth::Revoked | Auth::Unknown => None,
    }
}

fn refusal(status: StatusCode, e: impl Into<WireError>) -> Response<Body> {
    let mut res = json_response(&e.into());
    *res.status_mut() = status;
    res
}

/// `PUT /v1/blobs`: stage a file for a coming `agents.send`.
pub async fn upload(c: Arc<Companion>, req: Request<Incoming>) -> Response<Body> {
    let Some(device) = authorize(&c, req.headers()) else {
        return status_only(StatusCode::UNAUTHORIZED);
    };
    let headers = req.headers();
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_FILE_BYTES) {
        return status_only(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let name = headers
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| urlencoding::decode(v).ok())
        .map(|n| n.into_owned())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "file".into());
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = match tokio::time::timeout(UPLOAD_TIMEOUT, read_upload(req.into_body())).await {
        Err(_) => return status_only(StatusCode::REQUEST_TIMEOUT),
        Ok(Upload::TooBig) => return status_only(StatusCode::PAYLOAD_TOO_LARGE),
        Ok(Upload::Broken) => return status_only(StatusCode::BAD_REQUEST),
        Ok(Upload::Done(bytes)) => bytes,
    };
    let staged = tokio::task::spawn_blocking(move || {
        c.blobs
            .put(&device.id, &name, mime.as_deref(), &bytes, now_ms())
    })
    .await;
    match staged {
        Ok(Ok(blob)) => json_response(&blob.as_ref()),
        // Over this phone's staging budget: the sentence says what to do.
        Ok(Err(e)) => refusal(StatusCode::TOO_MANY_REQUESTS, e),
        Err(_) => status_only(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

enum Upload {
    Done(Vec<u8>),
    TooBig,
    Broken,
}

/// Read an upload up to the limit. Past it, the rest is read and thrown
/// away (up to as much again) before the 413, so a phone streaming a body
/// with no declared length hears "too large" rather than a reset socket.
async fn read_upload(mut incoming: Incoming) -> Upload {
    let limit = MAX_FILE_BYTES as usize;
    let mut kept = Vec::new();
    let mut seen = 0usize;
    while let Some(frame) = incoming.frame().await {
        let Ok(frame) = frame else {
            return Upload::Broken;
        };
        let Some(data) = frame.data_ref() else {
            continue;
        };
        seen += data.len();
        if seen <= limit {
            kept.extend_from_slice(data);
        } else {
            kept = Vec::new();
            if seen > limit * 2 {
                return Upload::TooBig;
            }
        }
    }
    if seen > limit {
        Upload::TooBig
    } else {
        Upload::Done(kept)
    }
}

/// What a GET resolved to: a file on disk and how to label it.
struct Served {
    path: PathBuf,
    name: String,
    mime: String,
    /// Attachments never change once written; a blob is gone in an hour.
    immutable: bool,
}

/// `/v1/blobs/<id>` or `/v1/agents/<id>/attachments/<path…>`, for this device.
fn resolve(c: &Companion, device: &DeviceRecord, path: &str) -> Option<Served> {
    if let Some(id) = path.strip_prefix("/v1/blobs/") {
        let id = urlencoding::decode(id).ok()?;
        let blob = c.blobs.get(&device.id, &id, now_ms())?;
        return Some(Served {
            path: blob.path,
            name: blob.name,
            mime: blob.mime,
            immutable: false,
        });
    }
    let rest = path.strip_prefix("/v1/agents/")?;
    let (agent, rel) = rest.split_once("/attachments/")?;
    let agent = urlencoding::decode(agent).ok()?;
    let mut segments = vec!["attachments".to_string()];
    for raw in rel.split('/') {
        let seg = urlencoding::decode(raw).ok()?.into_owned();
        // `attachments::resolve` refuses these too; a decoded slash would
        // smuggle a second segment past this split.
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(['/', '\\', '\0']) {
            return None;
        }
        segments.push(seg);
    }
    let rel = segments.join("/");
    let full = c.backend.attachment_file(&agent, &rel).ok()?;
    let name = segments.last().cloned().unwrap_or_default();
    Some(Served {
        path: full,
        mime: mime_for(&name).to_string(),
        name,
        immutable: true,
    })
}

/// `?w=<px>`, clamped; `None` when absent or not a number.
fn thumb_width(query: Option<&str>) -> Option<u32> {
    query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("w="))
        .and_then(|w| w.parse::<u32>().ok())
        .map(|w| w.clamp(MIN_THUMB_WIDTH, MAX_THUMB_WIDTH))
}

/// Raster formats the image crate here decodes. SVG and HEIC are served as
/// they are.
fn thumbnailable(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

/// A JPEG no wider than `width` (never upscaled).
pub fn thumbnail(path: &std::path::Path, width: u32) -> Option<Vec<u8>> {
    let img = image::open(path).ok()?;
    let img = if img.width() > width {
        img.resize(width, u32::MAX, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    img.to_rgb8().write_with_encoder(encoder).ok()?;
    Some(out.into_inner())
}

/// A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range within `len`.
/// `Err` when it is a range but not one that can be satisfied.
/// A `Range` header that names bytes the file doesn't have (416).
#[derive(Debug, PartialEq, Eq)]
pub struct Unsatisfiable;

pub fn parse_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, Unsatisfiable> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        // Several ranges: answer with the whole file, which is allowed.
        return Ok(None);
    }
    let (a, b) = spec.split_once('-').ok_or(Unsatisfiable)?;
    let (a, b) = (a.trim(), b.trim());
    let range = match (a.is_empty(), b.is_empty()) {
        (true, false) => {
            let n: u64 = b.parse().map_err(|_| Unsatisfiable)?;
            if n == 0 {
                return Err(Unsatisfiable);
            }
            (len.saturating_sub(n), len.saturating_sub(1))
        }
        (false, _) => {
            let start: u64 = a.parse().map_err(|_| Unsatisfiable)?;
            let end = if b.is_empty() {
                len.saturating_sub(1)
            } else {
                b.parse::<u64>()
                    .map_err(|_| Unsatisfiable)?
                    .min(len.saturating_sub(1))
            };
            (start, end)
        }
        (true, true) => return Err(Unsatisfiable),
    };
    if len == 0 || range.0 > range.1 || range.0 >= len {
        return Err(Unsatisfiable);
    }
    Ok(Some(range))
}

/// `GET` (or `HEAD`) a blob or an attachment.
pub async fn download(c: Arc<Companion>, req: Request<Incoming>) -> Response<Body> {
    let Some(device) = authorize(&c, req.headers()) else {
        return status_only(StatusCode::UNAUTHORIZED);
    };
    let Some(served) = resolve(&c, &device, req.uri().path()) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let head = req.method() == Method::HEAD;
    let width = thumb_width(req.uri().query()).filter(|_| thumbnailable(&served.mime));
    let range_header = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let read = tokio::task::spawn_blocking(move || -> Result<Read, StatusCode> {
        if let Some(width) = width {
            if let Some(jpeg) = thumbnail(&served.path, width) {
                return Ok(Read {
                    bytes: jpeg,
                    mime: "image/jpeg".into(),
                    range: None,
                    total: None,
                    served,
                });
            }
        }
        let len = std::fs::metadata(&served.path)
            .map_err(|_| StatusCode::NOT_FOUND)?
            .len();
        let range = parse_range(range_header.as_deref(), len)
            .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
        let bytes = read_bytes(&served.path, range).map_err(|_| StatusCode::NOT_FOUND)?;
        Ok(Read {
            bytes,
            mime: served.mime.clone(),
            range,
            total: Some(len),
            served,
        })
    })
    .await;
    let read = match read {
        Ok(Ok(r)) => r,
        Ok(Err(status)) => return status_only(status),
        Err(_) => return status_only(StatusCode::INTERNAL_SERVER_ERROR),
    };
    respond(read, head)
}

struct Read {
    bytes: Vec<u8>,
    mime: String,
    range: Option<(u64, u64)>,
    /// The file's full length, for `Accept-Ranges` (absent for a thumbnail).
    total: Option<u64>,
    served: Served,
}

fn read_bytes(path: &std::path::Path, range: Option<(u64, u64)>) -> std::io::Result<Vec<u8>> {
    use std::io::{Read as _, Seek, SeekFrom};
    let Some((start, end)) = range else {
        return std::fs::read(path);
    };
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (end - start + 1) as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

fn respond(read: Read, head: bool) -> Response<Body> {
    let len = read.bytes.len();
    let mut res = Response::new(if head {
        body(Bytes::new())
    } else {
        body(read.bytes)
    });
    if read.range.is_some() {
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    let h = res.headers_mut();
    let mut set = |name: header::HeaderName, value: String| {
        if let Ok(v) = header::HeaderValue::from_str(&value) {
            h.insert(name, v);
        }
    };
    set(header::CONTENT_TYPE, read.mime);
    set(header::CONTENT_LENGTH, len.to_string());
    set(
        header::CACHE_CONTROL,
        if read.served.immutable {
            "private, max-age=86400".into()
        } else {
            "private, no-store".into()
        },
    );
    set(header::X_CONTENT_TYPE_OPTIONS, "nosniff".into());
    set(
        header::CONTENT_DISPOSITION,
        format!(
            "inline; filename*=UTF-8''{}",
            urlencoding::encode(&read.served.name)
        ),
    );
    if let Some(total) = read.total {
        set(header::ACCEPT_RANGES, "bytes".into());
        if let Some((start, end)) = read.range {
            set(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            );
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_single_and_inside_the_file() {
        assert_eq!(parse_range(None, 10), Ok(None));
        assert_eq!(parse_range(Some("bytes=0-3"), 10), Ok(Some((0, 3))));
        assert_eq!(parse_range(Some("bytes=4-"), 10), Ok(Some((4, 9))));
        assert_eq!(parse_range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(parse_range(Some("bytes=5-100"), 10), Ok(Some((5, 9))));
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), Ok(None));
        assert!(parse_range(Some("bytes=10-"), 10).is_err());
        assert!(parse_range(Some("bytes=5-2"), 10).is_err());
        assert!(parse_range(Some("bytes=x-"), 10).is_err());
    }

    #[test]
    fn thumbnail_widths_are_clamped() {
        assert_eq!(thumb_width(Some("w=200")), Some(200));
        assert_eq!(thumb_width(Some("a=1&w=99999")), Some(MAX_THUMB_WIDTH));
        assert_eq!(thumb_width(Some("w=1")), Some(MIN_THUMB_WIDTH));
        assert_eq!(thumb_width(Some("w=big")), None);
        assert_eq!(thumb_width(None), None);
    }
}
