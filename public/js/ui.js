/* Small shared helpers for the public site and the admin panel. */
window.UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** el('div', { className: 'x', onclick: fn, dataset: { a: 1 } }, child, 'text', ...) */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  }

  let toastBox;
  let lastToast = '';
  function toast(message, kind = '') {
    if (!toastBox) {
      toastBox = el('div', { className: 'toasts', role: 'status', ariaLive: 'polite' });
      document.body.append(toastBox);
    }
    if (message === lastToast && toastBox.childElementCount) return; // no stacks of the same message
    lastToast = message;
    const node = el('div', { className: `toast ${kind}` }, message);
    toastBox.append(node);
    setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3500);
  }

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------
  let csrf = '';
  const setCsrf = (token) => { csrf = token || ''; };

  const STATUS_MESSAGES = {
    0: 'Network problem. Check your connection and try again.',
    401: 'Your session has ended. Please sign in again.',
    403: 'That action is not allowed.',
    404: 'Not found.',
    413: 'That upload is too large. Use a smaller image or file.',
    415: 'That request was not understood.',
    429: 'Too many requests from your network. Wait a minute and try again.',
    500: 'Something went wrong on our side. Please try again.',
    502: 'The site is restarting. Try again in a minute.',
    503: 'The site is busy or restarting. Try again in a minute.',
    504: 'The server took too long to respond. Try again in a minute.',
    507: 'The server is out of storage. Please tell the organisers.',
  };
  const fail = (message, status, fields) => Object.assign(new Error(message), { status, fields });

  /** fetch with a timeout and friendly errors for offline, timeout and aborted requests. */
  async function request(url, options, timeout) {
    if (navigator.onLine === false) throw fail('You are offline. Connect to the internet and try again.', 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, credentials: 'same-origin', signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw fail('The server took too long to respond. Check your connection and try again.', 0);
      throw fail(STATUS_MESSAGES[0], 0);
    } finally {
      clearTimeout(timer);
    }
  }

  function buildOptions(method, body) {
    const options = { method, headers: {} };
    if (method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body ?? {});
      if (csrf) options.headers['X-CSRF-Token'] = csrf;
    }
    return options;
  }

  /** JSON API call. Throws an Error carrying .status and .fields on any failure. */
  async function api(url, { method = 'GET', body, timeout = 30000 } = {}) {
    const res = await request(url, buildOptions(method, body), timeout);
    let data = null;
    try { data = await res.json(); } catch { /* not JSON: proxy error page, empty body */ }
    if (!res.ok) {
      throw Object.assign(fail(data?.error || STATUS_MESSAGES[res.status] || `Request failed (${res.status}). Please try again.`, res.status, data?.fields), { data });
    }
    if (data == null) throw fail('The server sent an unexpected reply. Please try again.', res.status);
    return data;
  }

  /** Downloads a file through fetch, so a failure becomes a message and not a broken page. */
  async function download(url, fallbackName) {
    const res = await request(url, { method: 'GET' }, 60000);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw fail(data?.error || STATUS_MESSAGES[res.status] || `Download failed (${res.status}).`, res.status);
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
    const link = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  // -------------------------------------------------------------------------
  // Formatting and dialogs
  // -------------------------------------------------------------------------
  const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
  const dateTime = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  /** Promise based confirm box built on <dialog>. Resolves true or false. */
  function confirmBox({ title, message, okText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const dialog = el('dialog', { className: 'narrow' },
        el('div', { className: 'dlg-head' }, el('h3', {}, title)),
        el('div', { className: 'dlg-body' }, el('p', {}, message)),
        el('div', { className: 'dlg-foot' },
          el('button', { type: 'button', className: 'btn white', onclick: () => dialog.close('no') }, 'Cancel'),
          el('button', { type: 'button', className: `btn ${danger ? 'red' : ''}`, onclick: () => dialog.close('yes') }, okText)));
      dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'yes'); dialog.remove(); });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /** Runs an async action with the button disabled and relabelled, so it cannot be fired twice. */
  async function busy(button, label, action) {
    if (button.disabled) return undefined;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await action();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // Last line of defence: an unexpected script error still tells the person something.
  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    toast(event.reason?.status != null ? event.reason.message : 'Something went wrong. Refresh the page and try again.', 'error');
  });
  window.addEventListener('error', (event) => {
    if (event.error) toast('Something went wrong. Refresh the page and try again.', 'error');
  });
  window.addEventListener('offline', () => toast('You are offline.', 'error'));
  window.addEventListener('online', () => toast('Back online.'));

  return { $, $$, el, toast, api, download, setCsrf, rupees, dateTime, confirmBox, busy };
})();
