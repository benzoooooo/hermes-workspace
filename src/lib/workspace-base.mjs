/** Public path prefix for hosting the workspace behind a reverse proxy. */

export function normalizeWorkspaceBase(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return ''
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '')
}

export function viteBase(value) {
  const normalized = normalizeWorkspaceBase(value)
  return normalized ? `${normalized}/` : '/'
}

export function cookiePath(value) {
  return normalizeWorkspaceBase(value) || '/'
}

export function prefixRootUrl(base, input) {
  const normalized = normalizeWorkspaceBase(base)
  if (!normalized || typeof input !== 'string' || input.length === 0) return input
  if (input.startsWith('//')) return input
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input
  if (!input.startsWith('/')) return input
  if (input === normalized || input.startsWith(`${normalized}/`)) return input
  return `${normalized}${input}`
}

export function prefixSameOriginUrl(base, input, origin) {
  if (typeof input !== 'string') return input
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) return prefixRootUrl(base, input)
  let url
  try {
    url = new URL(input)
  } catch {
    return input
  }
  if (!origin || url.origin !== origin) return input
  const nextPath = prefixRootUrl(base, `${url.pathname}${url.search}${url.hash}`)
  if (nextPath === `${url.pathname}${url.search}${url.hash}`) return input
  return `${url.origin}${nextPath}`
}

export function stripWorkspaceBase(base, pathname) {
  const normalized = normalizeWorkspaceBase(base)
  const path = pathname || '/'
  if (!normalized) return path
  if (path === normalized) return '/'
  if (path.startsWith(`${normalized}/`)) {
    const stripped = path.slice(normalized.length)
    return stripped.length > 0 ? stripped : '/'
  }
  return path
}

export function browserShimSource(base) {
  const normalized = normalizeWorkspaceBase(base)
  return `(() => {
  const base = ${JSON.stringify(normalized)};
  if (!base) return;
  window.__HERMES_WORKSPACE_BASEPATH__ = base;
  const already = (path) => path === base || path.startsWith(base + '/');
  const prefixPath = (path) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || already(path)) return path;
    return base + path;
  };
  const prefix = (input) => {
    if (typeof input !== 'string') return input;
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      try {
        const url = new URL(input);
        if (url.origin !== window.location.origin) return input;
        const next = prefixPath(url.pathname) + url.search + url.hash;
        return url.origin + next;
      } catch { return input; }
    }
    return prefixPath(input);
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') return origFetch(prefix(input), init);
    if (input instanceof Request) {
      const next = prefix(input.url);
      if (next !== input.url) return origFetch(new Request(next, input), init);
    }
    return origFetch(input, init);
  };
  const OrigEventSource = window.EventSource;
  window.EventSource = function (url, options) {
    return new OrigEventSource(prefix(url), options);
  };
  window.EventSource.prototype = OrigEventSource.prototype;
  const OrigWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const next = typeof url === 'string' ? prefix(url) : url;
    return protocols === undefined ? new OrigWebSocket(next) : new OrigWebSocket(next, protocols);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  const visualEl = (el) => el instanceof HTMLImageElement || el instanceof HTMLSourceElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement;
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const attr = String(name).toLowerCase();
    const next = visualEl(this) && (attr === 'src' || attr === 'poster') && typeof value === 'string' ? prefix(value) : value;
    return origSetAttribute.call(this, name, next);
  };
  const patchSrc = (proto) => {
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(value) { desc.set.call(this, prefix(value)); },
    });
  };
  patchSrc(HTMLImageElement.prototype);
  if (typeof HTMLSourceElement !== 'undefined') patchSrc(HTMLSourceElement.prototype);
})();`
}
