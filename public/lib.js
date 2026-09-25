const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- DOM helpers (text always via text nodes, never innerHTML) ---------- */

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  setProps(node, props);
  append(node, children);
  return node;
}

export function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v);
  append(node, children);
  return node;
}

function setProps(node, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const ICONS = {
  check: 'M3 8.5l3 3 7-7',
  alert: 'M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.6v.1',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
  arrow: 'M3 8h10M9 4l4 4-4 4',
  trash: 'M2.5 4.5h11M6.5 4.5V2.8h3v1.7M4 4.5l.7 9h6.6l.7-9',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  left: 'M10 3.5 5.5 8l4.5 4.5',
};

export function icon(name) {
  return s('svg', { class: 'icon', width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    s('path', { d: ICONS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

export function key(color) {
  return h('span', { class: 'key', style: { background: color } });
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
