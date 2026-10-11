// Minimal native DOM helpers. No innerHTML: works under Trusted Types.

type Child = Node | string | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = v as string;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

// Icon paths from design/reference/screens.
const ICONS = {
  bolt: ['<M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  settings: ['<M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'o12,12,3'],
  import: ['<M12 15V3', '<M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', '<m7 10 5 5 5-5'],
  minus: ['<M5 12h14'],
  x: ['<M18 6 6 18', '<m6 6 12 12'],
  home: ['<M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8', '<M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  flask: ['<M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2', '<M8.5 2h7', '<M7 16h10'],
  server: ['r2,2,20,8', 'r2,14,20,8', '<M6 6h.01', '<M6 18h.01'],
  shuffle: ['<m18 14 4 4-4 4', '<m18 2 4 4-4 4', '<M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-7.6a4 4 0 0 1 3.3-1.7H22', '<M2 6h1.972a4 4 0 0 1 3.6 2.2', '<M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45'],
  route: ['o6,19,3', '<M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15', 'o18,5,3'],
  flame: ['<M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z'],
  chevronRight: ['<m9 18 6-6-6-6'],
  play: ['<M6 3 20 12 6 21Z'],
  stop: ['r6,6,12,12'],
  pause: ['r6,4,4,16', 'r14,4,4,16'],
  book: ['<M12 7v14', '<M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'],
  check: ['<M20 6 9 17l-5-5'],
  plus: ['<M5 12h14', '<M12 5v14'],
  back: ['<m12 19-7-7 7-7', '<M19 12H5'],
  info: ['o12,12,10', '<M12 16v-4', '<M12 8h.01'],
  save: ['<M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', '<M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7', '<M7 3v4a1 1 0 0 0 1 1h7'],
  trash: ['<M3 6h18', '<M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', '<M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  restore: ['<M8 3H5a2 2 0 0 0-2 2v3', '<M21 8V5a2 2 0 0 0-2-2h-3', '<M3 16v3a2 2 0 0 0 2 2h3', '<M16 21h3a2 2 0 0 0 2-2v-3'],
  alert: ['<m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', '<M12 9v4', '<M12 17h.01'],
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = 'aw-i'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of ICONS[name]) {
    let el: SVGElement;
    if (spec[0] === '<') {
      el = document.createElementNS(NS, 'path');
      el.setAttribute('d', spec.slice(1));
    } else {
      const [x, y, a, b] = spec.slice(1).split(',');
      if (spec[0] === 'o') {
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', x!); el.setAttribute('cy', y!); el.setAttribute('r', a!);
      } else {
        el = document.createElementNS(NS, 'rect');
        el.setAttribute('x', x!); el.setAttribute('y', y!); el.setAttribute('width', a!); el.setAttribute('height', b!); el.setAttribute('rx', '2');
      }
    }
    svg.append(el);
  }
  return svg;
}
