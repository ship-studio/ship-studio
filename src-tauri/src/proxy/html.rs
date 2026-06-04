//! # HTML Injection Utilities
//!
//! Functions for injecting scripts and error overlays into HTML responses.
//! Used by the preview proxy to add navigation tracking and error display.

use super::{NAV_SCRIPT, SELECT_SCRIPT};

/// Inject the navigation tracking script + the (inert until activated) visual-
/// editor selection layer into an HTML response body.
pub fn inject_nav_script(html: &[u8]) -> Vec<u8> {
    inject_into_html(html, &format!("{NAV_SCRIPT}{SELECT_SCRIPT}"))
}

/// Inject an arbitrary HTML/CSS/JS snippet into an HTML document.
/// Tries before </head>, then </body>, then appends to end.
pub fn inject_into_html(html: &[u8], snippet: &str) -> Vec<u8> {
    let body = String::from_utf8_lossy(html);

    // Try to inject before </head> (earliest execution)
    if let Some(pos) = body.find("</head>") {
        let byte_pos = body[..pos].len();
        let mut result = Vec::with_capacity(html.len() + snippet.len());
        result.extend_from_slice(&html[..byte_pos]);
        result.extend_from_slice(snippet.as_bytes());
        result.extend_from_slice(&html[byte_pos..]);
        return result;
    }

    // Fallback: before </body>
    if let Some(pos) = body.find("</body>") {
        let byte_pos = body[..pos].len();
        let mut result = Vec::with_capacity(html.len() + snippet.len());
        result.extend_from_slice(&html[..byte_pos]);
        result.extend_from_slice(snippet.as_bytes());
        result.extend_from_slice(&html[byte_pos..]);
        return result;
    }

    // Final fallback: append to end
    let mut result = html.to_vec();
    result.extend_from_slice(snippet.as_bytes());
    result
}

/// Attempt to extract a human-readable error message from an HTML error response.
/// Tries multiple strategies for different frameworks (Next.js, Vite, generic).
pub fn extract_error_message(html: &str) -> String {
    // Strategy 1: Next.js __NEXT_DATA__ JSON with error info
    if let Some(start) = html.find("__NEXT_DATA__") {
        if let Some(json_start) = html[start..].find('>') {
            let after_tag = start + json_start + 1;
            if let Some(json_end) = html[after_tag..].find("</script>") {
                let json_str = &html[after_tag..after_tag + json_end];
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(msg) = val.pointer("/err/message").and_then(|v| v.as_str()) {
                        return msg.to_string();
                    }
                    if let Some(msg) = val
                        .pointer("/props/pageProps/error/message")
                        .and_then(|v| v.as_str())
                    {
                        return msg.to_string();
                    }
                }
            }
        }
    }

    // Strategy 2: Error in <pre> tag (common in many frameworks)
    if let Some(pre_start) = html.find("<pre>") {
        let content_start = pre_start + 5;
        if let Some(pre_end) = html[content_start..].find("</pre>") {
            let content = &html[content_start..content_start + pre_end];
            let cleaned = content
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .replace("&quot;", "\"");
            if !cleaned.trim().is_empty() {
                let truncated = if cleaned.len() > 2000 {
                    &cleaned[..2000]
                } else {
                    &cleaned
                };
                return truncated.trim().to_string();
            }
        }
    }

    // Strategy 3: Error in <h1> or <h2> tags
    for tag in &["<h1>", "<h2>"] {
        if let Some(start) = html.find(tag) {
            let content_start = start + tag.len();
            let close_tag = tag.replace('<', "</");
            if let Some(end) = html[content_start..].find(&close_tag) {
                let text = &html[content_start..content_start + end];
                let clean_text = strip_html_tags(text);
                if !clean_text.trim().is_empty() && clean_text.len() < 500 {
                    return clean_text.trim().to_string();
                }
            }
        }
    }

    // Strategy 4: <title> tag containing error keywords
    if let Some(start) = html.find("<title>") {
        let content_start = start + 7;
        if let Some(end) = html[content_start..].find("</title>") {
            let title = &html[content_start..content_start + end];
            if !title.trim().is_empty()
                && title.len() < 200
                && (title.contains("Error") || title.contains("error") || title.contains("500"))
            {
                return title.trim().to_string();
            }
        }
    }

    // Fallback
    "The dev server returned an error. Check the terminal for details.".to_string()
}

/// Strip HTML tags from a string, leaving only text content.
pub fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(ch);
        }
    }
    result
}

/// Build a self-contained error overlay (HTML/CSS/JS) for 5xx responses.
/// Forces body visible (overrides Next.js FOUC prevention), shows a styled error panel,
/// and sends a postMessage to the parent so Ship Studio can log the error.
pub fn build_error_overlay(status_code: u16, error_message: &str) -> String {
    let escaped_message = error_message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('\n', "<br>");

    let js_escaped = error_message
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    format!(
        r#"<style>
body{{display:block!important;visibility:visible!important;opacity:1!important}}
.__ss-err-overlay{{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#1e1e1e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#ccc;display:flex;align-items:center;justify-content:center;padding:24px}}
.__ss-err-panel{{max-width:680px;width:100%;background:#252526;border:1px solid #3c3c3c;border-radius:12px;overflow:hidden}}
.__ss-err-header{{display:flex;align-items:center;gap:10px;padding:16px 20px;background:#2d2d2d;border-bottom:1px solid #3c3c3c}}
.__ss-err-badge{{background:#f44747;color:#fff;font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px}}
.__ss-err-title{{font-size:14px;font-weight:600;color:#ccc}}
.__ss-err-body{{padding:20px;max-height:400px;overflow-y:auto}}
.__ss-err-msg{{font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:13px;line-height:1.6;color:#d4d4d4;white-space:pre-wrap;word-break:break-word;background:#1e1e1e;padding:16px;border-radius:8px;border:1px solid #3c3c3c}}
.__ss-err-hint{{margin-top:16px;font-size:12px;color:#6d6d6d;text-align:center}}
.__ss-err-footer{{display:flex;gap:8px;padding:16px 20px;border-top:1px solid #3c3c3c;justify-content:flex-end}}
.__ss-err-btn{{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:6px;border:1px solid #3c3c3c;background:#2d2d2d;color:#ccc;font-size:12px;font-weight:500;cursor:pointer;transition:background 0.15s}}
.__ss-err-btn:hover{{background:#3c3c3c}}
.__ss-err-btn--primary{{background:#D97757;border-color:#D97757;color:#fff}}
.__ss-err-btn--primary:hover{{background:#C4684A}}
</style>
<div class="__ss-err-overlay"><div class="__ss-err-panel">
<div class="__ss-err-header"><span class="__ss-err-badge">{status_code}</span><span class="__ss-err-title">Dev Server Error</span></div>
<div class="__ss-err-body"><div class="__ss-err-msg">{escaped_message}</div><div class="__ss-err-hint">Check the terminal for full error details</div></div>
<div class="__ss-err-footer"><button class="__ss-err-btn" id="__ss-err-copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy Error</button><button class="__ss-err-btn __ss-err-btn--primary" id="__ss-err-send">Send to Claude</button></div>
</div></div>
<script>(function(){{
var msg='{js_escaped}';
window.parent.postMessage({{type:'shipstudio:error',status:{status_code},message:msg}},'*');
document.getElementById('__ss-err-copy').onclick=function(){{
window.parent.postMessage({{type:'shipstudio:copy-error',message:msg}},'*');
this.textContent='Copied!';var b=this;setTimeout(function(){{b.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy Error'}},1500)
}};
document.getElementById('__ss-err-send').onclick=function(){{
window.parent.postMessage({{type:'shipstudio:send-error-to-claude',message:msg}},'*')
}};
}})()</script>"#,
    )
}

/// Inject error overlay + nav script into an HTML response with a 5xx status.
pub fn inject_error_into_html(html: &[u8], status_code: u16) -> Vec<u8> {
    let body_str = String::from_utf8_lossy(html);
    let error_message = extract_error_message(&body_str);
    let overlay = build_error_overlay(status_code, &error_message);
    let injection = format!("{overlay}{NAV_SCRIPT}");
    inject_into_html(html, &injection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_before_head() {
        let html = b"<html><head><title>Test</title></head><body>Hello</body></html>";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        // Both scripts land before </head>, nav first.
        assert!(result_str.contains(&format!("{NAV_SCRIPT}{SELECT_SCRIPT}</head>")));
    }

    #[test]
    fn test_inject_before_body_fallback() {
        let html = b"<html><body>Hello</body></html>";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains(&format!("{NAV_SCRIPT}{SELECT_SCRIPT}</body>")));
    }

    #[test]
    fn test_inject_append_fallback() {
        let html = b"<html>Hello";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.ends_with(SELECT_SCRIPT));
        assert!(result_str.contains("ss:select"));
    }

    #[test]
    fn select_script_supports_live_style_patch() {
        // The selection script must apply an inline-style patch on ss:mutate so
        // the preview is independent of Tailwind's JIT (a freshly-typed class has
        // no compiled CSS). Guards the include_str! script content.
        assert!(SELECT_SCRIPT.contains("d.style"));
        assert!(SELECT_SCRIPT.contains("setProperty"));
        assert!(SELECT_SCRIPT.contains("ss:mutate"));
    }

    #[test]
    fn test_extract_error_from_next_data() {
        let html = r#"<html><head></head><body><script id="__NEXT_DATA__" type="application/json">{"err":{"message":"Module not found: Can't resolve 'missing-pkg'"}}</script></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Module not found"));
    }

    #[test]
    fn test_extract_error_from_pre_tag() {
        let html = r#"<html><body><pre>Error: Cannot find module 'react'</pre></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Cannot find module 'react'"));
    }

    #[test]
    fn test_extract_error_from_h1() {
        let html = r#"<html><body><h1>Internal Server Error</h1><p>Something went wrong</p></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Internal Server Error"));
    }

    #[test]
    fn test_extract_error_from_title() {
        let html =
            r#"<html><head><title>500 Internal Server Error</title></head><body></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("500 Internal Server Error"));
    }

    #[test]
    fn test_extract_error_fallback() {
        let html = r#"<html><body></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Check the terminal"));
    }

    #[test]
    fn test_strip_html_tags() {
        assert_eq!(strip_html_tags("<b>hello</b> world"), "hello world");
        assert_eq!(strip_html_tags("no tags"), "no tags");
        assert_eq!(strip_html_tags("<a href='x'>link</a>"), "link");
    }

    #[test]
    fn test_error_overlay_contains_status() {
        let html = b"<html><head></head><body>error</body></html>";
        let result = inject_error_into_html(html, 500);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains("500"));
        assert!(result_str.contains("__ss-err-overlay"));
        assert!(result_str.contains("display:block!important"));
    }

    #[test]
    fn test_error_overlay_preserves_nav_script() {
        let html = b"<html><head></head><body>error</body></html>";
        let result = inject_error_into_html(html, 502);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains("shipstudio:navigate"));
        assert!(result_str.contains("shipstudio:error"));
    }

    #[test]
    fn test_error_message_escaping() {
        let overlay = build_error_overlay(500, "Module '<Foo>' not found & \"bar\"");
        assert!(overlay.contains("&lt;Foo&gt;"));
        assert!(overlay.contains("&amp;"));
        assert!(overlay.contains("&quot;bar&quot;"));
    }
}
