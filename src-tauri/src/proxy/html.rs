//! # HTML Injection Utilities
//!
//! Functions for injecting scripts and error overlays into HTML responses.
//! Used by the preview proxy to add navigation tracking and error display.

use super::{NAV_SCRIPT, RELOAD_SUPPRESS, SCROLLBAR_STYLE, SCROLL_RESTORE, SELECT_SCRIPT};

/// Inject the navigation tracking script + the (inert until activated) visual-
/// editor selection layer into an HTML response body, plus the scrollbar-hiding
/// style and the scroll-position restorer.
///
/// The scripts go at the *end* of `<head>` (latest, so they see the final DOM);
/// the scrollbar style + scroll-restore go at the *start* of `<head>` (earliest:
/// the site's own scrollbar styling overrides ours, and the scroll-restore must
/// run before first paint to avoid a visible jump — see those consts).
pub fn inject_nav_script(html: &[u8]) -> Vec<u8> {
    let with_scripts = inject_into_html(html, &format!("{NAV_SCRIPT}{SELECT_SCRIPT}"));
    inject_at_head_start(
        &with_scripts,
        &format!("{SCROLLBAR_STYLE}{RELOAD_SUPPRESS}{SCROLL_RESTORE}"),
    )
}

/// Insert a snippet immediately *after* the opening `<head>` tag (falling back to
/// after `<html>`, then the document start). Unlike `inject_into_html` (which
/// lands at the end of `<head>`), this places the snippet *before* the site's own
/// stylesheets in cascade order — use it for low-priority defaults a site should
/// be able to override.
pub fn inject_at_head_start(html: &[u8], snippet: &str) -> Vec<u8> {
    let body = String::from_utf8_lossy(html);

    // After the opening `<head …>` tag (covers `<head>` and `<head class="…">`).
    if let Some(head) = body.find("<head") {
        if let Some(gt) = body[head..].find('>') {
            return splice_at(html, head + gt + 1, snippet);
        }
    }

    // Fallback: after the opening `<html …>` tag.
    if let Some(htmltag) = body.find("<html") {
        if let Some(gt) = body[htmltag..].find('>') {
            return splice_at(html, htmltag + gt + 1, snippet);
        }
    }

    // Final fallback: prepend to the document.
    let mut result = Vec::with_capacity(html.len() + snippet.len());
    result.extend_from_slice(snippet.as_bytes());
    result.extend_from_slice(html);
    result
}

/// Splice `snippet` into `html` at byte offset `pos`.
fn splice_at(html: &[u8], pos: usize, snippet: &str) -> Vec<u8> {
    let mut result = Vec::with_capacity(html.len() + snippet.len());
    result.extend_from_slice(&html[..pos]);
    result.extend_from_slice(snippet.as_bytes());
    result.extend_from_slice(&html[pos..]);
    result
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

/// Shared overlay panel builder. `title` is the header line next to the status
/// badge, `intro` is an optional pre-escaped explanatory paragraph rendered
/// above the monospace message block, `message` is the raw error/reason string
/// (escaped here, and wired to the Copy / Send-to-Claude buttons), and `hint`
/// is the muted footer line inside the body.
fn build_overlay_panel(
    status_code: u16,
    title: &str,
    intro: Option<&str>,
    message: &str,
    hint: &str,
) -> String {
    let escaped_message = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('\n', "<br>");

    let js_escaped = message
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    let intro_html = intro
        .map(|i| format!(r#"<div class="__ss-err-intro">{i}</div>"#))
        .unwrap_or_default();

    format!(
        r#"<style>
body{{display:block!important;visibility:visible!important;opacity:1!important}}
.__ss-err-overlay{{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#1e1e1e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#ccc;display:flex;align-items:center;justify-content:center;padding:24px}}
.__ss-err-panel{{max-width:680px;width:100%;background:#252526;border:1px solid #3c3c3c;border-radius:12px;overflow:hidden}}
.__ss-err-header{{display:flex;align-items:center;gap:10px;padding:16px 20px;background:#2d2d2d;border-bottom:1px solid #3c3c3c}}
.__ss-err-badge{{background:#f44747;color:#fff;font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px}}
.__ss-err-title{{font-size:14px;font-weight:600;color:#ccc}}
.__ss-err-body{{padding:20px;max-height:400px;overflow-y:auto}}
.__ss-err-intro{{font-size:13px;line-height:1.6;color:#9d9d9d;margin-bottom:14px}}
.__ss-err-msg{{font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:13px;line-height:1.6;color:#d4d4d4;white-space:pre-wrap;word-break:break-word;background:#1e1e1e;padding:16px;border-radius:8px;border:1px solid #3c3c3c}}
.__ss-err-hint{{margin-top:16px;font-size:12px;color:#6d6d6d;text-align:center}}
.__ss-err-footer{{display:flex;gap:8px;padding:16px 20px;border-top:1px solid #3c3c3c;justify-content:flex-end}}
.__ss-err-btn{{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:6px;border:1px solid #3c3c3c;background:#2d2d2d;color:#ccc;font-size:12px;font-weight:500;cursor:pointer;transition:background 0.15s}}
.__ss-err-btn:hover{{background:#3c3c3c}}
.__ss-err-btn--primary{{background:#D97757;border-color:#D97757;color:#fff}}
.__ss-err-btn--primary:hover{{background:#C4684A}}
</style>
<div class="__ss-err-overlay"><div class="__ss-err-panel">
<div class="__ss-err-header"><span class="__ss-err-badge">{status_code}</span><span class="__ss-err-title">{title}</span></div>
<div class="__ss-err-body">{intro_html}<div class="__ss-err-msg">{escaped_message}</div><div class="__ss-err-hint">{hint}</div></div>
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

/// Build a self-contained error overlay (HTML/CSS/JS) for 5xx responses.
/// Forces body visible (overrides Next.js FOUC prevention), shows a styled error panel,
/// and sends a postMessage to the parent so Ship Studio can log the error.
pub fn build_error_overlay(status_code: u16, error_message: &str) -> String {
    build_overlay_panel(
        status_code,
        "Dev Server Error",
        None,
        error_message,
        "Check the terminal for full error details",
    )
}

/// Explanation shown on the auth-redirect-loop interstitial. Pre-escaped HTML.
const AUTH_REDIRECT_INTRO: &str = "The dev server is running, but this page's auth middleware \
kept redirecting the preview until it gave up. Embedded previews (like any cross-site iframe) \
block third-party auth cookies, so the sign-in handshake can never finish. Clerk \
<b>development keys</b> are the most common cause &mdash; they bounce the first visit through \
<code>&lt;your-app&gt;.clerk.accounts.dev</code> to set a handshake cookie. To fix it, scope \
<code>clerkMiddleware</code> (or your auth middleware) to only the routes that need protection, \
or use a production Clerk instance. The site itself is fine &mdash; it loads normally in a \
regular browser tab, where the cookie is first-party.";

/// Build a complete standalone HTML page shown instead of forwarding an
/// auth-handshake redirect that would loop the preview iframe until WebKit
/// aborts it (issue #179). Served with a 200 status so WebKit actually renders
/// it. Includes the nav script so the parent's blank-pane watchdog sees the
/// page as alive and the Copy / Send-to-Claude buttons keep working.
pub fn build_auth_redirect_interstitial(status_code: u16, reason: &str) -> String {
    let overlay = build_overlay_panel(
        status_code,
        "This page couldn't load in the preview — it redirected too many times.",
        Some(AUTH_REDIRECT_INTRO),
        reason,
        "Open the site in a normal browser tab and it will load fine.",
    );
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Preview blocked: redirect loop</title></head><body>{overlay}{NAV_SCRIPT}</body></html>"
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
        // The selection script previews a freshly-typed class (no compiled CSS yet)
        // via an injected, breakpoint-aware stylesheet keyed to a marker attribute —
        // base rules bare, variants wrapped in @media so they only show at width.
        // Guards the include_str! script content.
        assert!(SELECT_SCRIPT.contains("ss:mutate"));
        assert!(SELECT_SCRIPT.contains("d.rules"));
        assert!(SELECT_SCRIPT.contains("data-ss-sel"));
        assert!(SELECT_SCRIPT.contains("@media (min-width:"));
        assert!(SELECT_SCRIPT.contains("ss-preview"));
    }

    #[test]
    fn scrollbar_style_lands_at_head_start_before_site_styles() {
        // The scrollbar-hiding style must come *before* the site's own <link>/<style>
        // so a site that styles its scrollbars overrides us (no hijack).
        let html =
            b"<html><head><link rel=\"stylesheet\" href=\"site.css\"></head><body>Hi</body></html>";
        let result = inject_nav_script(html);
        let s = String::from_utf8(result).unwrap();
        let style_pos = s
            .find("ss-hide-scrollbars")
            .expect("scrollbar style injected");
        let site_css_pos = s.find("site.css").expect("site css present");
        assert!(
            style_pos < site_css_pos,
            "scrollbar style must precede the site's stylesheet so the site can override it"
        );
        // And it must sit right after the opening <head>, ahead of the site link.
        assert!(s.contains("<head><style id=\"ss-hide-scrollbars\""));
        // Defensive: never use display:none or !important (that would hijack sites).
        let style = &s[style_pos..site_css_pos];
        assert!(!style.contains("display:none"));
        assert!(!style.contains("!important"));
    }

    #[test]
    fn inject_at_head_start_handles_attributed_head_and_fallbacks() {
        // <head> with attributes.
        let with_attrs =
            inject_at_head_start(b"<html><head class=\"x\"><title>T</title></head>", "S");
        assert!(String::from_utf8(with_attrs)
            .unwrap()
            .contains("<head class=\"x\">S<title>"));
        // No <head>: falls back to after <html>.
        let no_head = inject_at_head_start(b"<html><body>Hi</body></html>", "S");
        assert!(String::from_utf8(no_head)
            .unwrap()
            .starts_with("<html>S<body>"));
        // No <head> or <html>: prepends.
        let bare = inject_at_head_start(b"Hello", "S");
        assert_eq!(String::from_utf8(bare).unwrap(), "SHello");
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

    #[test]
    fn test_error_overlay_keeps_dev_server_title_and_no_intro() {
        // The generalized panel builder must not change the 5xx overlay.
        let overlay = build_error_overlay(500, "boom");
        assert!(overlay.contains("Dev Server Error"));
        assert!(!overlay.contains(r#"<div class="__ss-err-intro">"#));
    }

    #[test]
    fn test_auth_redirect_interstitial_contents() {
        let reason = "HTTP 307 redirect to https://foo.clerk.accounts.dev/v1/handshake";
        let page = build_auth_redirect_interstitial(307, reason);

        // Standalone document with the redirect status in the badge.
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains(r#"<span class="__ss-err-badge">307</span>"#));

        // Names the failure and the Clerk-specific cause + fixes.
        assert!(page.contains("redirected too many times"));
        assert!(page.contains("clerkMiddleware"));
        assert!(page.contains("clerk.accounts.dev"));
        assert!(page.contains("normal browser tab"));

        // Raw reason lands in the copyable monospace block.
        assert!(page.contains("__ss-err-msg"));
        assert!(page.contains("HTTP 307 redirect to https://foo.clerk.accounts.dev/v1/handshake"));

        // Copy / Send-to-Claude buttons keep working.
        assert!(page.contains("__ss-err-copy"));
        assert!(page.contains("__ss-err-send"));
        assert!(page.contains("shipstudio:copy-error"));
        assert!(page.contains("shipstudio:send-error-to-claude"));

        // The nav script rides along so the blank-pane watchdog sees the
        // interstitial as a live page (and the app can log the error).
        assert!(page.contains("shipstudio:alive"));
        assert!(page.contains("shipstudio:navigate"));
        assert!(page.contains("shipstudio:error"));
    }

    #[test]
    fn nav_script_posts_alive_on_parse() {
        // Part of the blank-pane watchdog contract: every injected page proves
        // life immediately on parse, independent of navigation semantics.
        assert!(NAV_SCRIPT.contains("shipstudio:alive"));
        assert!(NAV_SCRIPT.contains("shipstudio:navigate"));
    }
}
