// The build's accessibility helpers, proven on fixture HTML — plus the checks that scan dist/:
// every named region unique per page, every input labelled, no empty <th>, the changelog type
// chips at 4.5:1 in both themes, and the API reference's main landmark and h1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

/** Run focusable-tables.mjs over a fake dist/ and return the resulting page. */
function processPage(html) {
	const dir = mkdtempSync(join(tmpdir(), 'docs-a11y-'));
	mkdirSync(join(dir, 'dist'), { recursive: true });
	writeFileSync(join(dir, 'dist', 'index.html'), html);
	execFileSync('node', [join(ROOT, 'scripts/focusable-tables.mjs')], { env: { ...process.env, DIST: join(dir, 'dist') } });
	const out = readFileSync(join(dir, 'dist', 'index.html'), 'utf8');
	rmSync(dir, { recursive: true, force: true });
	return out;
}

test('a wide table becomes focusable, a small one stays put', () => {
	const wide = `<div class="table-wrapper"><table>${'<tr><th>column</th>'.repeat(12)}</tr>${'<tr><td>value with quite a long cell text here</td>'.repeat(12)}</tr>'.repeat(6)}</table></div>`;
	const small = `<div class="table-wrapper"><table><tr><td>a</td><td>b</td></tr></table></div>`;
	const out = processPage(`<html><body>${wide}${small}</body></html>`);
	const tabbed = out.match(/tabindex="0" role="region" aria-label="Scrollable table 1"/g) ?? [];
	assert.equal(tabbed.length, 1, 'exactly one table got the attributes');
	assert.ok(out.indexOf(tabbed[0]) < out.indexOf(small), 'it was the wide one');
});

test('every named region on a page gets a unique accessible name', () => {
	const pre = '<pre tabindex="0" role="region" aria-label="Code example"><code>x</code></pre>';
	const out = processPage(`<html><body>${pre}${pre}${pre}</body></html>`);
	assert.match(out, /aria-label="Code example 1"/);
	assert.match(out, /aria-label="Code example 2"/);
	assert.match(out, /aria-label="Code example 3"/);
	assert.ok(!out.includes('aria-label="Code example"'), 'no duplicated landmark name left');
});

test('a task-list item renders as a marked list item, not a disabled unlabelled checkbox', () => {
	const list = '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> migrated</li><li class="task-list-item"><input type="checkbox" disabled> restored</li></ul>';
	const out = processPage(`<html><body>${list}</body></html>`);
	assert.ok(!out.includes('type="checkbox"'), 'no checkbox input survives');
	assert.match(out, /aria-label="done">✓</);
	assert.match(out, /aria-label="to do">○</);
	assert.ok(out.includes('migrated') && out.includes('restored'), 'the item text stays');
});

test('inline scripts get hashed into the CSP', () => {
	const dir = mkdtempSync(join(tmpdir(), 'docs-csp-'));
	mkdirSync(join(dir, 'dist'), { recursive: true });
	writeFileSync(join(dir, 'dist', 'index.html'), `<html><body><script>console.log('hi')</script></body></html>`);
	writeFileSync(join(dir, 'dist', '_headers'), `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' INLINE_SCRIPT_HASHES\n`);
	execFileSync('node', [join(ROOT, 'scripts/csp-hashes.mjs')], { env: { ...process.env, DIST: join(dir, 'dist') } });
	const headers = readFileSync(join(dir, 'dist', '_headers'), 'utf8');
	assert.match(headers, /script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/);
	assert.ok(!headers.includes('INLINE_SCRIPT_HASHES'), 'the marker was replaced');
	rmSync(dir, { recursive: true, force: true });
});

// ---- The dist/ scans below run after `npm run build`; with no dist they skip. ----

const htmlPages = [];
if (existsSync(DIST)) {
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.html')) htmlPages.push(path);
		}
	};
	walk(DIST);
}
const noDist = { skip: htmlPages.length === 0 };

test('no page has two regions with the same accessible name', noDist, () => {
	for (const page of htmlPages) {
		const html = readFileSync(page, 'utf8');
		const names = [...html.matchAll(/role="region"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
		const seen = new Set();
		for (const name of names) {
			assert.ok(!seen.has(name), `${page.split('/dist/')[1]}: the region "${name}" appears twice`);
			seen.add(name);
		}
	}
});

test('every rendered input carries a label', noDist, () => {
	for (const page of htmlPages) {
		const html = readFileSync(page, 'utf8');
		for (const [tag] of html.matchAll(/<input\b([^>]*)>/g)) {
			if (/type="hidden"/.test(tag)) continue;
			const labelled = /aria-label(ledby)?=/.test(tag) || ((tag.match(/id="([^"]+)"/) ?? [])[1] && html.includes(`for="${tag.match(/id="([^"]+)"/)[1]}"`));
			assert.ok(labelled, `${page.split('/dist/')[1]}: <input${tag}> has no label`);
		}
	}
});

test('no table header cell is empty', noDist, () => {
	for (const page of htmlPages) {
		const html = readFileSync(page, 'utf8');
		const empty = html.match(/<th(\s[^>]*)?>\s*<\/th>/);
		assert.equal(empty, null, `${page.split('/dist/')[1]}: an empty <th>`);
	}
});

test('the API reference page has a main landmark and a level-one heading', noDist, () => {
	const ref = join(DIST, 'api', 'reference', 'index.html');
	if (!existsSync(ref)) assert.fail('api/reference/index.html missing from dist');
	const html = readFileSync(ref, 'utf8');
	assert.match(html, /<main[\s>]/, 'no <main>');
	assert.match(html, /<h1[\s>]/, 'no <h1>');
});

// --- Changelog type chips: resolve the theme palettes out of the built CSS and measure. ---

/** WCAG relative luminance of an [r,g,b] triple in 0..255. */
const luminance = ([r, g, b]) => {
	const lin = (c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
	const [hi, lo] = [Math.max(a, b), Math.min(a, b)];
	return (hi + 0.05) / (lo + 0.05);
};

/** hsl(h°, s%, l%) → [r,g,b]. */
function hsl(h, s, l) {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Resolve a token name to [r,g,b] within one theme's declarations (hex, hsl(), color-mix of two). */
function colour(name, decls, vars) {
	if (!name.startsWith('--')) name = `--${name}`;
	const raw = decls[name];
	if (!raw) assert.fail(`the palette has no ${name}`);
	const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const h = hex[1];
		const [r, g, b] = h.length === 3 ? [h[0] + h[0], h[1] + h[1], h[2] + h[2]] : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
		return [parseInt(r, 16), parseInt(g, 16), parseInt(b, 16)];
	}
	const hslMatch = raw.match(/^hsl\((var\(--sl-hue-[a-z]+\)|[\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)$/i);
	if (hslMatch) {
		const hue = hslMatch[1].startsWith('var') ? Number(vars[hslMatch[1].slice(4, -1)]) : Number(hslMatch[1]);
		return hsl(hue, Number(hslMatch[2]) / 100, Number(hslMatch[3]) / 100);
	}
	const mix = raw.match(/^color-mix\(in srgb,\s*(var\(--[a-z-]+\d?\))\s*(\d+)%,\s*(var\(--[a-z-]+\d?\))\)/i);
	if (mix) {
		const a = colour(mix[1].slice(4, -1), decls, vars);
		const b = colour(mix[3].slice(4, -1), decls, vars);
		const w = Number(mix[2]) / 100;
		return a.map((v, i) => Math.round(v * w + b[i] * (1 - w)));
	}
	const ref = raw.match(/^var\(--([a-z-]+\d?)(?:\s*,[^)]*)?\)$/i);
	if (ref) return colour(ref[1], decls, vars);
	assert.fail(`unresolvable colour for ${name}: ${raw}`);
}

test('every changelog type chip meets 4.5:1 on its surface in both themes', noDist, () => {
	const cssFile = readdirSync(join(DIST, '_astro'))
		.map((n) => join(DIST, '_astro', n))
		.find((n) => n.endsWith('.css') && readFileSync(n, 'utf8').includes('--sl-hue-orange'));
	assert.ok(cssFile, 'no emitted CSS carries the Starlight palette');
	const css = readFileSync(cssFile, 'utf8');
	// Merge every :root-scoped declaration block into the two theme tables: base tokens under
	// :root (the dark default), the :root[data-theme=light] ones overriding them for light.
	const themes = { ':root': {}, ':root[data-theme=light]': {} };
	for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const light = /data-theme=light/.test(m[1]);
		const table = light ? themes[':root[data-theme=light]'] : /(^|[\s,]):root/.test(m[1]) ? themes[':root'] : null;
		if (!table) continue;
		for (const d of m[2].matchAll(/(--[a-zA-Z-]+\d?)\s*:\s*([^;}]+)/g)) table[d[1]] = d[2].trim();
	}
	themes[':root[data-theme=light]'] = { ...themes[':root'], ...themes[':root[data-theme=light]'] };
	const cases = [
		['chip', '--sl-color-gray-2'],
		['chip-type', '--sl-color-white'],
		['chip-security', '--c-warn'],
		['chip-breaking', '--c-warn'],
	];
	for (const [theme, d] of Object.entries(themes)) {
		const vars = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('--sl-hue')).map(([k, v]) => [k, Number(v)]));
		const surface = luminance(colour('--chip-bg', d, vars));
		for (const [cls, token] of cases) {
			const ratio = contrast(luminance(colour(token, d, vars)), surface);
			assert.ok(ratio >= 4.5, `${cls} on ${theme}: ${ratio.toFixed(2)}:1 < 4.5:1`);
		}
	}
});
