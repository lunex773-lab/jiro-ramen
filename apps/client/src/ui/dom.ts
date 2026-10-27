// 小さな DOM ヘルパー（UI フレームワークは使わない）。

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: HTMLElement, ...children: (Child | Child[])[]): void {
  clear(el);
  append(el, children);
}

export function yenStr(v: number): string {
  const sign = v < 0 ? '−' : '';
  return `${sign}¥${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`;
}

export function stars(v: number): string {
  const full = Math.floor(v);
  const half = v - full >= 0.5 ? 1 : 0;
  return '★'.repeat(full) + (half ? '☆' : '') + '·'.repeat(Math.max(0, 5 - full - half));
}

/** 確認ダイアログ（ブラウザ標準の confirm はスマホで見づらいので自前） */
export function confirmDialog(root: HTMLElement, title: string, body: string, okLabel = 'OK', danger = false, cancelLabel = 'キャンセル'): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = h(
      'div',
      { class: 'modal-overlay' },
      h(
        'div',
        { class: 'modal' },
        h('h3', null, title),
        h('p', { class: 'modal-body' }, body),
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, cancelLabel),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel),
        ),
      ),
    );
    root.appendChild(overlay);
  });
}

export function promptDialog(root: HTMLElement, title: string, initial: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value: initial, placeholder, maxLength: 20 }) as HTMLInputElement;
    const close = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = h(
      'div',
      { class: 'modal-overlay' },
      h(
        'div',
        { class: 'modal' },
        h('h3', null, title),
        input,
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => close(null) }, 'キャンセル'),
          h('button', { class: 'btn primary', onclick: () => close(input.value.trim() || null) }, '決定'),
        ),
      ),
    );
    root.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  });
}

export function toast(root: HTMLElement, text: string, level: 'info' | 'warn' | 'danger' | 'good' = 'info', ms = 2600): void {
  let host = root.querySelector<HTMLElement>('.toasts');
  if (!host) {
    host = h('div', { class: 'toasts' });
    root.appendChild(host);
  }
  const t = h('div', { class: `toast ${level}` }, text);
  host.appendChild(t);
  while (host.children.length > 4) host.firstElementChild?.remove();
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  }, ms);
}
