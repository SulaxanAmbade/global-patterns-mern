import { cleanAdmin } from './admins.js';

export const headerName = (value) =>
  String(value ?? '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .toLowerCase();

export const languageCode = (value) =>
  cleanAdmin(value).toLowerCase().replaceAll('_', '-');

// QBEN is a custom code present in this application's dataset.
const customLanguages = new Set(['qben']);

export function validLanguage(value) {
  const code = languageCode(value);

  return (
    customLanguages.has(code) ||
    /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)
  );
}

function patternLanguages(value) {
  const found = new Set();
  const pattern = String(value ?? '');

  for (const match of pattern.matchAll(
    /(?:^|[?&*])lang=([a-z0-9_-]+)(?=$|[?&*#\s])/gi,
  )) {
    const code = languageCode(match[1]);

    if (validLanguage(code)) {
      found.add(code);
    }
  }

  return [...found];
}

export function repairWorkbookRow(input) {
  const row = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      headerName(k),
      v !== null && typeof v === 'object'
        ? v
        : cleanAdmin(v)
          ? String(v)
              .replace(/[\u200b-\u200d\ufeff]/g, '')
              .trim()
          : '',
    ]),
  );

  const fixes = [];

  if (
    !cleanAdmin(row.url_pattern_id) &&
    cleanAdmin(row.total_count)
  ) {
    row.url_pattern_id = cleanAdmin(row.total_count);
    fixes.push('pattern_id_from_total_count');
  }

  const original = languageCode(row.language_code);
  const fallback = languageCode(row.url_pattern_order);

  let issue = '';

  if (validLanguage(original)) {
    row.language_code = original;
  } else {
    const fromPattern = patternLanguages(row.url_pattern);
    const candidates = new Set(fromPattern);

    if (validLanguage(fallback)) {
      candidates.add(fallback);
    }

    // Never guess when explicit sources disagree.
    if (candidates.size === 1) {
      row.language_code = [...candidates][0];

      fixes.push(
        validLanguage(fallback)
          ? 'language_from_url_pattern_order'
          : 'language_from_url_pattern',
      );
    } else {
      row.language_code = '';

      if (candidates.size > 1) {
        issue =
          'Conflicting language codes in url_pattern_order and url_pattern';
      } else if (original) {
        issue =
          'Invalid language_code; no usable language in url_pattern_order or explicit lang= value';
      }
    }
  }

  delete row._alignment_issue;

  if (issue) {
    row._alignment_issue = issue;
  }

  return {
    row,
    fixes,
    issue,
    originalLanguage: cleanAdmin(
      Object.entries(input).find(
        ([k]) => headerName(k) === 'language_code',
      )?.[1],
    ),
    missingLanguage: !row.language_code,
  };
}