export const text = (v) => String(v ?? '').trim();
export const key = (v) =>
  text(v).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
export function decode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
export const words = (v) =>
  decode(text(v))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export const basisKey = (v) => words(v).join(' ');
export function splitPattern(value) {
  let p = text(value).replace(/\\\*/g, '*');
  if (p.startsWith('*')) p = p.slice(1);
  const i = p.indexOf('*');
  if (i < 0) return [p, ''];
  return [
    p.slice(0, i).trim(),
    p
      .slice(i + 1)
      .replace(/\*$/, '')
      .trim(),
  ];
}
export function cleanDomain(value) {
  let d = text(value);
  const m = d.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i);
  if (m) d = m[1];
  if (/^(https?:)?\/\//i.test(d)) {
    try {
      return new URL(d.startsWith('//') ? 'https:' + d : d).hostname;
    } catch {}
  }
  return d;
}
export function pattern(domain, basis) {
  domain = cleanDomain(domain);
  return `*${domain.startsWith('patternkeywords.global.promote') ? 'patternkeywords.global.promote' : domain}*${text(basis)}*`;
}
export function forms(w) {
  const f = new Set([w]);
  if (w.length > 3) {
    if (w.endsWith('ies')) {
      f.add(w.slice(0, -3) + 'y');
      f.add(w.slice(0, -1));
    } else if (
      /(sses|shes|ches|xes|zes)$/.test(w) ||
      ['buses', 'statuses'].includes(w)
    )
      f.add(w.slice(0, -2));
    else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) f.add(w.slice(0, -1));
  }
  return f;
}
export function fragments(basis) {
  return decode(text(basis))
    .replace(/\\/g, '')
    .split('*')
    .map((part) => {
      const out = [];
      for (const m of part.matchAll(/~([^~]*)~|([^~]+)/g)) {
        const lock = m[1] !== undefined;
        out.push(
          ...words(lock ? m[1] : m[2]).map((w) => (lock ? `~${w}~` : w)),
        );
      }
      return out;
    })
    .filter((a) => a.length);
}
export function priority(v) {
  const s = text(v).replaceAll(',', '');
  const n = Number(s);
  return s && Number.isFinite(n) && n >= 0 ? n : Infinity;
}
export function totalRow(row) {
  return Object.values(row).some((v) =>
    /^(grand total|report total|stripped url \(others\))$/i.test(text(v)),
  );
}
export function number(v, label = 'Value') {
  const s = text(v)
    .replace(/[$,%\s]/g, '')
    .replaceAll(',', '');
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0)
    throw Error(
      `${label} must be a nonnegative number: ${text(v).slice(0, 60)}`,
    );
  return n;
}
export function keywords(v) {
  if (Array.isArray(v)) return [...new Set(v.flatMap(keywords))];
  if (v && typeof v === 'object')
    throw Error('Keywords must be a list or delimited text');
  const s = text(v);
  if (!s) return [];
  if (s.startsWith('[')) return keywords(JSON.parse(s));
  return [
    ...new Set(
      s
        .split(/[\n;|]+|(?<!\d),|,(?!\d)/)
        .map(text)
        .filter(Boolean),
    ),
  ];
}
