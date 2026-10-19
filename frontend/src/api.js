let csrf = '';
export function setCSRF(value) {
  csrf = value;
}
export async function api(url, options = {}) {
  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : options.body
        ? { 'Content-Type': 'application/json' }
        : {}),
    ...(options.method && options.method !== 'GET'
      ? { 'X-CSRF-Token': csrf }
      : {}),
    ...options.headers,
  };
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });
  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {}
    throw Error(data?.error || `Request failed (${response.status})`);
  }
  return response.json();
}
export async function submitFile(url, file, options) {
  const body = new FormData();
  if (file) body.append('file', file);
  body.append('options', JSON.stringify(options));
  return api(url, { method: 'POST', body });
}
export async function download(url, body, name) {
  const r = await fetch('/api' + url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error((await r.json()).error);
  save(await r.blob(), name);
}
export function save(content, name, type = 'text/plain') {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
