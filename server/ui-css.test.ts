import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Visual release guard: text sitting on the forced-white checkbox-list panel must
// declare its own dark color (the lists render inside a dark panel whose inherited
// light text color made labels nearly invisible - 26 Oct contrast regression).
const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const m = css.match(new RegExp(selector.replace(/[.[\]]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, `missing CSS rule for ${selector}`);
  return m![1];
}
function rootVar(name: string): string {
  const m = css.match(new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{6})'));
  assert.ok(m, `missing :root var --${name}`);
  return m![1];
}
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('checkbox list text meets WCAG AA contrast on its own panel background', () => {
  const rawBg = rule('.cblist').match(/background\s*:\s*(#[0-9a-fA-F]{3,6})/)?.[1];
  const listBg = rawBg && rawBg.length === 4 ? '#' + [...rawBg.slice(1)].map((c) => c + c).join('') : rawBg;
  assert.ok(listBg, '.cblist must declare an explicit hex background');
  const itemColor = rule('.cbitem').match(/color\s*:\s*var\(--([a-z-]+)\)/)?.[1];
  assert.ok(itemColor, '.cbitem must declare an explicit color (no inheritance from the dark panel)');
  const ratio = contrast(rootVar(itemColor), listBg);
  assert.ok(ratio >= 4.5, `.cbitem text on .cblist background: contrast ${ratio.toFixed(2)} < 4.5`);
});
