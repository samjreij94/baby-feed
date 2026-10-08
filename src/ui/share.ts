/** Share sheet with clipboard fallback. */
export async function shareInvite(link: string, code: string): Promise<'shared' | 'copied' | 'failed'> {
  const text = `Join our Baby Feed household. Open this link on your iPhone, or enter the code ${code}.`;
  if (typeof navigator.share === 'function') {
    try { await navigator.share({ title: 'Baby Feed invite', text, url: link }); return 'shared'; } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'failed';
    }
  }
  return copyText(link);
}

export async function copyText(s: string): Promise<'copied' | 'failed'> {
  try { await navigator.clipboard.writeText(s); return 'copied'; } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = s; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok ? 'copied' : 'failed';
    } catch { return 'failed'; }
  }
}
