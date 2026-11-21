// The _headers rules serve-dist applies, and the storage pins the privacy check
// enforces: blocks apply in file order, `*` matches anything, a specific rule
// can override a `/*` value for one header name, and every stored entry must be
// a pinned key, in its pinned area, holding Starlight's own shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHeaders, headersFor } from './serve-dist.mjs';
import { storageVerdict } from './lib/allowed-storage.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('every matching rule applies, later rules winning per header', () => {
	const rules = parseHeaders(`/*\n  X-One: a\n  X-Two: b\n\n/*.md\n  Content-Type: text/markdown\n`);
	const html = headersFor(rules, '/guide/');
	assert.equal(html['X-One'], 'a');
	assert.equal(html['X-Two'], 'b');
	assert.equal(html['Content-Type'], undefined, 'no .md rule on a page');
	const md = headersFor(rules, '/guide.md');
	assert.equal(md['X-One'], 'a', '/* still applies');
	assert.equal(md['Content-Type'], 'text/markdown');
});

test('a wildcard inside a pattern only matches what it covers', () => {
	const rules = parseHeaders(`/api/*\n  X-Api: yes\n`);
	assert.equal(headersFor(rules, '/api/reference/')['X-Api'], 'yes');
	assert.equal(headersFor(rules, '/other/')['X-Api'], undefined);
});

test('comments and blank lines carry no rule', () => {
	const rules = parseHeaders(`# a comment\n\n/*\n  X-One: a\n\n# another\n`);
	assert.equal(rules.length, 1);
	assert.deepEqual(rules[0].headers, [['X-One', 'a']]);
});

test('the shipped _headers gives every path its CSP and markdown its type', () => {
	const file = join(ROOT, 'dist', '_headers');
	if (!existsSync(file)) return; // before the first build there is nothing to parse
	const rules = parseHeaders(readFileSync(file, 'utf8'));
	const page = headersFor(rules, '/quick-start/');
	assert.match(page['Content-Security-Policy'] ?? '', /script-src 'self' 'wasm-unsafe-eval' 'sha256-/, 'the build filled the inline-script hashes');
	assert.equal(page['Referrer-Policy'], 'no-referrer');
	const md = headersFor(rules, '/quick-start.md');
	assert.equal(md['Content-Type'], 'text/markdown; charset=utf-8');
});

// ---- The storage pins: a key only Starlight could write, in its area, in its shape. ----

test('the theme key only lives in localStorage as light, dark or empty', () => {
	assert.equal(storageVerdict('localStorage', 'starlight-theme', 'dark'), null);
	assert.equal(storageVerdict('localStorage', 'starlight-theme', ''), null, 'empty is auto');
	assert.ok(storageVerdict('sessionStorage', 'starlight-theme', 'dark'), 'wrong area');
	assert.ok(storageVerdict('localStorage', 'starlight-theme', '{"accent":"blue"}'), 'a payload is not the theme');
});

test('the sidebar key only lives in sessionStorage as Starlight\'s state object', () => {
	const good = JSON.stringify({ i: '07funsf', open: { '07funsf': true, abc: false }, scroll: 213 });
	assert.equal(storageVerdict('sessionStorage', 'sl-sidebar-state', good), null);
	assert.ok(storageVerdict('localStorage', 'sl-sidebar-state', good), 'wrong area — it must die with the tab');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', 'true'), 'not JSON');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', '{"i":"x","open":"all","scroll":0}'), 'open must be a map of booleans');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', '{"i":"x","open":{},"scroll":"0"}'), 'scroll must be a number');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', '{"i":"x","open":{}}'), 'missing scroll');
});

test('any other key fails wherever it is found', () => {
	for (const area of ['localStorage', 'sessionStorage']) {
		assert.ok(storageVerdict(area, 'recent-searches', '[]'), `${area}: a new key is a fail, not a warning`);
		assert.ok(storageVerdict(area, 'pagefind-filters', '{}'));
		assert.ok(storageVerdict(area, 'user-id', 'x'));
	}
});
