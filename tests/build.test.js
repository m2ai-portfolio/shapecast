import { describe, it, expect } from 'vitest';
import { buildPage } from '../scripts/build.mjs';

describe('buildPage', () => {
  it('inlines modules, strips import/export, keeps marker order', () => {
    const page = '<title>T</title>\n<!-- @inline-modules -->\n<p>x</p>';
    const modules = [
      {
        name: 'a.js',
        source: "import { b } from './b.js';\nexport function a() { return b(); }\n",
      },
      { name: 'b.js', source: 'export const b = () => 1;\n' },
    ];
    const out = buildPage(page, modules);
    expect(out).not.toMatch(/^import /m);
    expect(out).not.toMatch(/^export /m);
    expect(out).toContain('// --- a.js ---');
    expect(out.indexOf('// --- a.js ---')).toBeLessThan(out.indexOf('// --- b.js ---'));
    expect(out).toContain('<p>x</p>');
    expect(out).not.toContain('@inline-modules');
  });
  it('refuses external script hosts other than cdnjs', () => {
    expect(() =>
      buildPage('<script src="https://esm.sh/x"></script><!-- @inline-modules -->', []),
    ).toThrow(/cdnjs/);
  });
  it('strips multi-line import blocks and preserves literal dollar signs ($${x})', () => {
    const src =
      "import {\n  a,\n  b,\n} from './x.js';\nexport const c = `$${(a + b).toFixed(2)}`;\n";
    const out = buildPage('<!-- @inline-modules -->', [{ name: 'm.js', source: src }]);
    expect(out).not.toMatch(/import/);
    expect(out).toContain('const c = `$${(a + b).toFixed(2)}`;');
  });
});
