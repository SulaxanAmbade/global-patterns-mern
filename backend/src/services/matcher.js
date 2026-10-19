import { fragments, forms, words, priority } from './normalize.js';
// Compact token trie. Only the least common required fragment nominates a basis.
export function buildMatcher(catalog) {
  const nodes = [new Map()],
    terminals = new Map(),
    fragmentIds = new Map(),
    requirements = [],
    frequency = [];
  for (const row of catalog) {
    const required = new Map();
    for (const fragment of fragments(row.basis)) {
      const name = JSON.stringify(fragment);
      let id = fragmentIds.get(name);
      if (id === undefined) {
        id = fragmentIds.size;
        fragmentIds.set(name, id);
        let node = 0;
        for (const token of fragment) {
          let next = nodes[node].get(token);
          if (next === undefined) {
            next = nodes.length;
            nodes[node].set(token, next);
            nodes.push(new Map());
          }
          node = next;
        }
        terminals.set(node, [...(terminals.get(node) || []), id]);
      }
      required.set(id, (required.get(id) || 0) + 1);
    }
    requirements.push(required);
    for (const id of required.keys()) frequency[id] = (frequency[id] || 0) + 1;
  }
  const anchors = new Map();
  requirements.forEach((r, i) => {
    if (!r.size) return;
    const id = [...r.keys()].sort((a, b) => frequency[a] - frequency[b])[0];
    anchors.set(id, [...(anchors.get(id) || []), i]);
  });
  const order = catalog
    .map((_, i) => i)
    .sort(
      (a, b) =>
        priority(catalog[a].priority) - priority(catalog[b].priority) ||
        String(catalog[b].basis).length - String(catalog[a].basis).length ||
        String(catalog[a].basis).localeCompare(String(catalog[b].basis)) ||
        String(catalog[a].language_code).localeCompare(
          String(catalog[b].language_code),
        ),
    );
  const rank = new Map(order.map((id, i) => [id, i]));
  return (raw) => {
    let url;
    try {
      url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    } catch {
      return null;
    }
    let active = new Set(),
      counts = new Map();
    for (const w of words(
      [url.hostname, url.pathname, url.search, url.hash].join(' '),
    )) {
      const next = new Set(),
        variants = [...forms(w), `~${w}~`];
      for (const node of new Set([0, ...active]))
        for (const v of variants) {
          const child = nodes[node].get(v);
          if (child !== undefined) next.add(child);
        }
      const found = new Set();
      for (const n of next)
        for (const id of terminals.get(n) || []) found.add(id);
      for (const id of found) counts.set(id, (counts.get(id) || 0) + 1);
      active = next;
    }
    let best;
    for (const id of counts.keys())
      for (const i of anchors.get(id) || []) {
        if (best !== undefined && rank.get(i) >= rank.get(best)) continue;
        if (
          [...requirements[i]].every(([fid, n]) => (counts.get(fid) || 0) >= n)
        )
          best = i;
      }
    return best === undefined ? null : catalog[best];
  };
}
