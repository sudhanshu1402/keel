#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';

const COLOR = {
  bg: '#0d1117',
  panel: '#161b22',
  edge: '#30363d',
  head: '#e6edf3',
  dim: '#7d8590',
  text: '#c9d1d9',
  good: '#3fb950',
  warn: '#d29922',
  bad: '#f85149',
  cool: '#58a6ff',
};

function escape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SVG collapses runs of spaces, so alignment is held by non-breaking spaces of the same width.
function cells(text) {
  return escape(text).replace(/ /g, '\u00a0');
}

// A quote in a label would close the attribute early and break the whole file.
function attr(text) {
  return escape(text).replace(/"/g, '&quot;');
}

function open(width, height, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${attr(label)}">
  <rect width="${width}" height="${height}" rx="10" fill="${COLOR.bg}" stroke="${COLOR.edge}"/>
  <g font-family="${MONO}">`;
}

const TILES = [
  ['DURABLE', 'steps replay', 'from disk', COLOR.good],
  ['DEPENDENCIES', 'zero', 'no dependencies field', COLOR.cool],
  ['INFRASTRUCTURE', 'none', 'memory, JSON or SQLite', COLOR.head],
  ['RECOVERY', '20,000 steps', 'replayed in 434 ms', COLOR.warn],
];

function glance() {
  // 195px tile holds 24 glyphs at font-size 12, 14 at font-size 16.
  for (const [, big, small] of TILES) if (small.length > 24 || big.length > 14) throw new Error(`tile text too long: ${big} / ${small}`);
  const width = 880;
  const height = 150;
  const tiles = TILES.map(([role, big, small, fill], i) => {
    const x = 20 + i * 215;
    return `<rect x="${x}" y="30" width="195" height="96" rx="8" fill="${COLOR.panel}" stroke="${COLOR.edge}"/>
    <text x="${x + 16}" y="56" fill="${COLOR.dim}" font-size="11" letter-spacing="1">${role}</text>
    <text x="${x + 16}" y="82" fill="${fill}" font-size="16" font-weight="600">${cells(big)}</text>
    <text x="${x + 16}" y="106" fill="${COLOR.dim}" font-size="12">${cells(small)}</text>`;
  }).join('\n    ');
  return `${open(width, height, 'keel at a glance: steps replay from disk, zero dependencies, no infrastructure, 20,000 steps replayed in 434 milliseconds')}
    ${tiles}
  </g>
</svg>
`;
}

const RUNS = [
  ['RUN 1', [
    ['charge', 'ran, saved', COLOR.good],
    ['reserve', 'ran, saved', COLOR.good],
    ['ship', 'never reached', COLOR.dim],
  ], 'process dies here', COLOR.bad],
  ['RUN 2', [
    ['charge', 'served from disk', COLOR.cool],
    ['reserve', 'served from disk', COLOR.cool],
    ['ship', 'ran once', COLOR.good],
  ], 'card charged once', COLOR.good],
];

const BOX = 180;

function replay() {
  const width = 880;
  const height = 250;
  // 180px box at font-size 14 holds 19 glyphs of the widest common monospace face.
  for (const [, steps] of RUNS) for (const [name] of steps) if (`ctx.step('${name}')`.length > 19) throw new Error(`step label too long: ${name}`);
  const rows = RUNS.map(([label, steps, note, noteFill], r) => {
    const y = 56 + r * 92;
    const boxes = steps.map(([name, state, fill], i) => {
      const x = 105 + i * 190;
      return `<rect x="${x}" y="${y}" width="${BOX}" height="62" rx="8" fill="${COLOR.panel}" stroke="${fill === COLOR.dim ? COLOR.edge : fill}"/>
    <text x="${x + 10}" y="${y + 26}" fill="${COLOR.text}" font-size="14" font-weight="600">${cells(`ctx.step('${name}')`)}</text>
    <text x="${x + 10}" y="${y + 47}" fill="${fill}" font-size="12">${cells(state)}</text>
    ${i === steps.length - 1 ? '' : `<path d="M${x + BOX + 2} ${y + 31}h6" stroke="${COLOR.edge}" stroke-width="2"/>`}`;
    }).join('\n    ');
    return `<text x="20" y="${y + 36}" fill="${COLOR.head}" font-size="13" font-weight="600">${label}</text>
    ${boxes}
    <text x="690" y="${y + 36}" fill="${noteFill}" font-size="12">${cells(note)}</text>`;
  }).join('\n    ');
  return `${open(width, height, 'Run 1 runs charge and reserve, saves both, then the process dies before ship. Run 2 serves charge and reserve from disk and runs ship once, so the card is charged exactly once')}
    <text x="20" y="30" fill="${COLOR.head}" font-size="14" font-weight="600">one run, two processes</text>
    ${rows}
    <text x="20" y="228" fill="${COLOR.dim}" font-size="12">${cells('a finished step is never run twice: keel hands back the saved result instead of calling the function again')}</text>
  </g>
</svg>
`;
}

mkdirSync(join(ROOT, 'assets'), { recursive: true });
for (const [name, markup] of [['glance.svg', glance()], ['replay.svg', replay()]]) {
  writeFileSync(join(ROOT, 'assets', name), markup);
  process.stdout.write(`wrote assets/${name}\n`);
}
