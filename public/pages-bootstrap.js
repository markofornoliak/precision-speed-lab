const configuredBase = String(window.__PSL_API_BASE__ || '').trim().replace(/\/$/, '');

if (configuredBase) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let sourceUrl;
    try {
      sourceUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }

    if (sourceUrl.origin !== window.location.origin || !sourceUrl.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    const target = `${configuredBase}${sourceUrl.pathname}${sourceUrl.search}${sourceUrl.hash}`;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return nativeFetch(new Request(target, input), init);
    }
    return nativeFetch(target, init);
  };
}
