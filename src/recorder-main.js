(() => {
  if (window.__dsrMainInstalled) return;
  window.__dsrMainInstalled = true;
  document.documentElement.dataset.dsrMain = 'ok';

  const STREAM_RE = /\/api\/v0\/chat\/(completion|regenerate|continue|edit_message|resume_stream)(\?|$)/;
  const SRC = 'dsr-main';
  const FLUSH_CHARS = 2048;
  const FLUSH_MS = 150;

  const bump = key => {
    const el = document.documentElement;
    el.dataset[key] = String(Number(el.dataset[key] || 0) + 1);
  };

  const nonce = () => document.documentElement.dataset.dsrNonce || '';

  const post = payload => {
    try {
      window.postMessage({ source: SRC, nonce: nonce(), ...payload }, location.origin);
    } catch {
      /* 转发失败不该影响页面 */
    }
  };

  function makeRecorder(url, requestBody) {
    const streamId = crypto.randomUUID();
    post({ type: 'start', streamId, url, requestBody, startedAt: Date.now() });
    let buf = '';
    let timer = null;
    let sawMeta = false;

    const flush = (done, error) => {
      clearTimeout(timer);
      timer = null;
      if (!buf && !done) return;
      post({ type: 'chunk', streamId, text: buf, at: Date.now(), done: !!done, error: error || null });
      buf = '';
    };

    return {
      append(text) {
        if (!text) return;
        buf += text;
        if (buf.length >= FLUSH_CHARS) flush(false, null);
        else if (!timer) timer = setTimeout(() => flush(false, null), FLUSH_MS);
      },
      meta: status => {
        if (sawMeta) return;
        sawMeta = true;
        post({ type: 'meta', streamId, status: status ?? null });
      },
      finish: error => flush(true, error),
    };
  }

  // 实测：DeepSeek 的 /chat/completion 走 XMLHttpRequest，不走 fetch。
  // XHR 流式期间 responseText 是累积的可读快照，读它不消耗数据，所以不需要 tee 副本。
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dsrUrl = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__dsrUrl || '';
    bump('dsrXhr');
    if (!STREAM_RE.test(url)) return origSend.apply(this, args);
    bump('dsrHits');

    const body = args[0];
    const rec = makeRecorder(url, typeof body === 'string' ? body : null);
    let consumed = 0;
    let finished = false;
    const onceFinish = err => { if (finished) return; finished = true; rec.finish(err); };

    const snapshot = () => {
      let text = '';
      try {
        text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
      } catch {
        return '';
      }
      if (text.length > consumed) {
        const delta = text.slice(consumed);
        consumed = text.length;
        return delta;
      }
      return '';
    };

    this.addEventListener('progress', () => {
      if (this.status) rec.meta(this.status);
      rec.append(snapshot());
    });
    this.addEventListener('loadend', () => {
      onceFinish(this.status >= 400 || !this.status ? `xhr-status-${this.status}` : null);
    });
    this.addEventListener('error', () => onceFinish('xhr-network-error'));
    this.addEventListener('abort', () => onceFinish('xhr-aborted'));

    return origSend.apply(this, args);
  };

  // fetch 路径一并保留：目前页面不用它，但换传输方式时不至于整个哑掉
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
    } catch { /* 取不到 url 就按非流式放行 */ }

    if (!STREAM_RE.test(url)) return nativeFetch.apply(this, arguments);
    bump('dsrFetch');
    bump('dsrHits');

    const raw = (init && init.body) ?? (typeof input === 'object' && input ? input.body : null);
    const rec = makeRecorder(url, typeof raw === 'string' ? raw : null);
    const decoder = new TextDecoder('utf-8');

    return nativeFetch.apply(this, arguments).then(
      response => {
        rec.meta(response.status);
        (async () => {
          try {
            if (!response.body) return rec.finish('no-body');
            const reader = response.clone().body.getReader();
            for (;;) {
              const r = await reader.read();
              if (r.value && r.value.length) rec.append(decoder.decode(r.value, { stream: !r.done }));
              if (r.done) {
                rec.append(decoder.decode());
                return rec.finish(null);
              }
            }
          } catch (err) {
            rec.finish(String((err && err.message) || err));
          }
        })();
        return response;
      },
      err => {
        rec.finish(String((err && err.message) || err));
        throw err;
      }
    );
  };
})();
