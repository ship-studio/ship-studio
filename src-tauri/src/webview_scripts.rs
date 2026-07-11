//! JavaScript snippets injected into Ship Studio webviews at load time.
//!
//! Registered on `WebviewWindowBuilder::initialization_script_for_all_frames`,
//! which on macOS (WKWebView) runs the script in every frame — including the
//! cross-origin preview iframe loading from the user's dev server.

/// Inspector shim injected into the preview iframe. Forwards console output,
/// uncaught errors, network requests (fetch + XHR), and a serialized DOM tree
/// to the parent window via `postMessage`. The parent's <BrowserTools/>
/// component subscribes to these events.
///
/// Skipped in:
/// - the main Tauri frame (top window) — we only want iframe inspection
/// - non-http(s) frames (e.g. the `about:blank` placeholder before load)
pub const INSPECTOR_SHIM: &str = r#"
(function () {
  try {
    if (window.top === window) return;
    var proto = window.location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;
    if (window.__shipstudio_inspector_installed) return;
    window.__shipstudio_inspector_installed = true;

    var CHANNEL = 'shipstudio-inspect';
    var seq = 0;

    var safeStringify = function (value, depth) {
      depth = depth || 0;
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      var t = typeof value;
      if (t === 'string') return value;
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
      if (t === 'function') return '[Function' + (value.name ? ' ' + value.name : '') + ']';
      if (t === 'symbol') return value.toString();
      if (value instanceof Error) {
        return value.name + ': ' + value.message + (value.stack ? '\n' + value.stack : '');
      }
      if (value instanceof Element) {
        return '<' + value.tagName.toLowerCase() +
          (value.id ? ' id="' + value.id + '"' : '') +
          (value.className && typeof value.className === 'string'
            ? ' class="' + value.className + '"' : '') + '>';
      }
      if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';
      try {
        return JSON.stringify(value, function (_k, v) {
          if (typeof v === 'bigint') return v.toString() + 'n';
          if (typeof v === 'function') return '[Function]';
          return v;
        }, 2);
      } catch (e) {
        try { return Object.prototype.toString.call(value); }
        catch (_) { return '[Unserializable]'; }
      }
    };

    var post = function (msg) {
      try {
        msg.source = CHANNEL;
        msg.seq = ++seq;
        msg.t = Date.now();
        window.parent.postMessage(msg, '*');
      } catch (_) {}
    };

    // --- Console ---
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var orig = console[level] ? console[level].bind(console) : function () {};
      console[level] = function () {
        try {
          var args = Array.prototype.slice.call(arguments).map(function (a) {
            return safeStringify(a);
          });
          post({ type: 'console', level: level, args: args });
        } catch (_) {}
        try { orig.apply(console, arguments); } catch (_) {}
      };
    });

    // --- Uncaught errors ---
    window.addEventListener('error', function (e) {
      post({
        type: 'console',
        level: 'error',
        args: [
          (e.message || 'Error') +
          (e.filename ? '\n  at ' + e.filename + ':' + e.lineno + ':' + e.colno : '') +
          (e.error && e.error.stack ? '\n' + e.error.stack : ''),
        ],
      });
    });
    window.addEventListener('unhandledrejection', function (e) {
      var reason = e.reason;
      post({
        type: 'console',
        level: 'error',
        args: ['Unhandled promise rejection: ' + safeStringify(reason)],
      });
    });

    // --- Network (fetch) ---
    var origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (origFetch) {
      window.fetch = function (input, init) {
        var id = 'f' + (++seq);
        var started = Date.now();
        var method = (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET';
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        post({ type: 'net-start', id: id, method: method, url: url });
        return origFetch(input, init).then(function (res) {
          post({
            type: 'net-end',
            id: id,
            method: method,
            url: url,
            status: res.status,
            ok: res.ok,
            duration: Date.now() - started,
          });
          return res;
        }).catch(function (err) {
          post({
            type: 'net-end',
            id: id,
            method: method,
            url: url,
            status: 0,
            ok: false,
            error: String(err && err.message || err),
            duration: Date.now() - started,
          });
          throw err;
        });
      };
    }

    // --- Network (XHR) ---
    var OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      var XHROpen = OrigXHR.prototype.open;
      var XHRSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url) {
        this.__ss_method = method;
        this.__ss_url = url;
        return XHROpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function () {
        var xhr = this;
        var id = 'x' + (++seq);
        var started = Date.now();
        post({ type: 'net-start', id: id, method: xhr.__ss_method || 'GET', url: xhr.__ss_url || '' });
        xhr.addEventListener('loadend', function () {
          post({
            type: 'net-end',
            id: id,
            method: xhr.__ss_method || 'GET',
            url: xhr.__ss_url || '',
            status: xhr.status,
            ok: xhr.status >= 200 && xhr.status < 400,
            duration: Date.now() - started,
          });
        });
        return XHRSend.apply(this, arguments);
      };
    }

    // --- DOM tree (Elements tab) ---
    // Serialize a bounded snapshot of the DOM. We cap depth and total node
    // count so very large pages (e.g. data tables with thousands of rows)
    // don't blow up postMessage payloads or the UI.
    var MAX_NODES = 1500;
    var MAX_DEPTH = 12;

    var serializeNode = function (node, depth, counter) {
      if (counter.n >= MAX_NODES) return null;
      if (depth > MAX_DEPTH) return null;
      var nodeType = node.nodeType;

      // Element
      if (nodeType === 1) {
        counter.n++;
        var attrs = {};
        if (node.attributes) {
          for (var i = 0; i < node.attributes.length; i++) {
            var a = node.attributes[i];
            var v = a.value;
            if (v && v.length > 200) v = v.substring(0, 200) + '…';
            attrs[a.name] = v;
          }
        }
        var children = [];
        var k = node.firstChild;
        while (k) {
          var child = serializeNode(k, depth + 1, counter);
          if (child) children.push(child);
          k = k.nextSibling;
        }
        return {
          kind: 'el',
          tag: node.tagName.toLowerCase(),
          attrs: attrs,
          children: children,
        };
      }

      // Text
      if (nodeType === 3) {
        var text = node.nodeValue || '';
        var trimmed = text.replace(/\s+/g, ' ').trim();
        if (!trimmed) return null;
        counter.n++;
        if (trimmed.length > 200) trimmed = trimmed.substring(0, 200) + '…';
        return { kind: 'text', text: trimmed };
      }

      // Comment
      if (nodeType === 8) {
        counter.n++;
        var c = (node.nodeValue || '').substring(0, 200);
        return { kind: 'comment', text: c };
      }

      return null;
    };

    var sendDomTree = function () {
      try {
        var root = document.documentElement;
        if (!root) return;
        var counter = { n: 0 };
        var tree = serializeNode(root, 0, counter);
        post({ type: 'dom-tree', tree: tree, truncated: counter.n >= MAX_NODES });
      } catch (e) {
        post({
          type: 'console',
          level: 'error',
          args: ['[ship-studio inspector] DOM serialization failed: ' + safeStringify(e)],
        });
      }
    };

    // Debounced auto-refresh on mutations — only while the host is subscribed
    // (i.e. the Elements view is actually visible). Re-serializing up to 1500
    // nodes every 300ms on mutation-heavy pages (animations flip attributes
    // constantly) is real main-thread work the previewed page must not pay
    // invisibly; it made the preview measurably jankier than Chrome.
    var domTimer = null;
    var domSubscribed = false;
    var domObserver = null;
    var scheduleDomSend = function () {
      if (!domSubscribed || domTimer) return;
      domTimer = setTimeout(function () {
        domTimer = null;
        if (domSubscribed) sendDomTree();
      }, 300);
    };

    var setDomSubscribed = function (on) {
      domSubscribed = !!on;
      if (!domSubscribed) {
        if (domTimer) {
          clearTimeout(domTimer);
          domTimer = null;
        }
        if (domObserver) {
          try {
            domObserver.disconnect();
          } catch (_) {}
          domObserver = null;
        }
        return;
      }
      var arm = function () {
        if (!domSubscribed || !document.documentElement || !window.MutationObserver) return;
        if (!domObserver) {
          try {
            domObserver = new MutationObserver(scheduleDomSend);
            domObserver.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          } catch (_) {}
        }
        sendDomTree();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arm, { once: true });
      } else {
        arm();
      }
    };

    // --- Agent actions (click / type / scroll / query) ---
    // Executed on behalf of the agent preview bridge. Every result carries the
    // target's viewport rect (as fractions) so the host can animate the agent
    // cursor to the real spot.

    var findTargets = function (selector, text) {
      var nodes;
      try { nodes = document.querySelectorAll(selector); }
      catch (err) { return { error: 'Invalid CSS selector: ' + selector }; }
      var list = Array.prototype.slice.call(nodes);
      if (text) {
        var needle = String(text).toLowerCase();
        list = list.filter(function (el) {
          return (el.textContent || '').toLowerCase().indexOf(needle) !== -1;
        });
      }
      return { list: list };
    };

    var describeEl = function (el) {
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return '<' + el.tagName.toLowerCase() +
        (el.id ? ' id="' + el.id + '"' : '') + '>' +
        (t ? ' "' + t.slice(0, 80) + '"' : '');
    };

    var rectOf = function (el) {
      var r = el.getBoundingClientRect();
      var vw = window.innerWidth || 1;
      var vh = window.innerHeight || 1;
      return {
        x: r.left, y: r.top, w: r.width, h: r.height,
        fx: Math.min(Math.max((r.left + r.width / 2) / vw, 0), 1),
        fy: Math.min(Math.max((r.top + r.height / 2) / vh, 0), 1)
      };
    };

    var execAction = function (d) {
      if (d.action === 'scroll') {
        if (d.selector) {
          var sf = findTargets(d.selector, d.text);
          if (sf.error) return { ok: false, error: sf.error };
          if (!sf.list.length) return { ok: false, error: 'No element matches selector: ' + d.selector };
          sf.list[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { ok: true, data: { scrolledTo: describeEl(sf.list[0]) }, rect: rectOf(sf.list[0]) };
        }
        var top = d.to === 'bottom' ? document.documentElement.scrollHeight
          : d.to === 'top' ? 0
          : (typeof d.y === 'number' ? d.y : 0);
        window.scrollTo({ top: top, behavior: 'smooth' });
        return { ok: true, data: { scrolledTo: d.to || top } };
      }
      if (d.action === 'query') {
        var qf = findTargets(d.selector, d.text);
        if (qf.error) return { ok: false, error: qf.error };
        var max = Math.min(qf.list.length, 10);
        var out = [];
        for (var i = 0; i < max; i++) {
          var qel = qf.list[i];
          var html = qel.outerHTML || '';
          out.push({
            match: describeEl(qel),
            visible: !!(qel.offsetWidth || qel.offsetHeight || qel.getClientRects().length),
            outerHTML: html.length > 2000 ? html.slice(0, 2000) + '…[truncated]' : html
          });
        }
        return { ok: true, data: { total: qf.list.length, returned: max, elements: out } };
      }
      // click / type target a single element
      var f = findTargets(d.selector, d.text);
      if (f.error) return { ok: false, error: f.error };
      if (!f.list.length) {
        return { ok: false, error: 'No element matches selector: ' + d.selector +
          (d.text ? ' containing text "' + d.text + '"' : '') };
      }
      var idx = typeof d.index === 'number' ? d.index : 0;
      if (idx >= f.list.length) {
        return { ok: false, error: 'index ' + idx + ' is out of range — only ' + f.list.length + ' matches' };
      }
      var el = f.list[idx];
      try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
      var rect = rectOf(el);
      if (d.action === 'click') {
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var fire = function (type) {
          try {
            el.dispatchEvent(new MouseEvent(type, {
              bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy
            }));
          } catch (_) {}
        };
        fire('pointerdown'); fire('mousedown'); fire('pointerup'); fire('mouseup');
        try { el.click(); } catch (err) { fire('click'); }
        return { ok: true, data: { clicked: describeEl(el), matches: f.list.length }, rect: rect };
      }
      if (d.action === 'type') {
        var value = String(d.value == null ? '' : d.value);
        var tag = el.tagName;
        try { el.focus(); } catch (_) {}
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          // React controlled inputs ignore direct .value writes — go through
          // the native setter so the framework's onChange actually fires.
          var protoObj = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var descr = Object.getOwnPropertyDescriptor(protoObj, 'value');
          if (descr && descr.set) { descr.set.call(el, value); } else { el.value = value; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          return { ok: false, error: 'Element is not typeable (not an input, textarea, or contenteditable): ' + describeEl(el) };
        }
        if (d.submit) {
          var form = el.form;
          if (form) {
            try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (_) {}
          } else {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          }
        }
        return { ok: true, data: { typedInto: describeEl(el), valueLength: value.length }, rect: rect };
      }
      return { ok: false, error: 'Unknown action: ' + d.action };
    };

    // Host commands: one-shot tree refresh, subscribe/unsubscribe from the
    // Elements view (drives the mutation observer above), and agent actions.
    // A fresh document always starts unsubscribed; the host re-arms on our
    // 'ready' beacon.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object' || d.source !== 'shipstudio-inspect-host') return;
      if (d.type === 'request-dom-tree') {
        sendDomTree();
      } else if (d.type === 'subscribe-dom-tree') {
        setDomSubscribed(true);
      } else if (d.type === 'unsubscribe-dom-tree') {
        setDomSubscribed(false);
      } else if (d.type === 'exec-action') {
        var res;
        try { res = execAction(d); }
        catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
        res.type = 'action-result';
        res.id = d.id;
        post(res);
      }
    });

    // --- Ready beacon so the host can clear stale state on navigation ---
    post({ type: 'ready', url: window.location.href });
  } catch (_) {
    // Never let the shim break the page.
  }
})();
"#;
