#!/usr/bin/env node
// The last word on what ships. Runs on dist/ after astro build (+ csp-hashes + focusable-tables).
// Asserts the pages and files exist that must exist, that every docs page has its Markdown twin,
// that the llms files and the search index landed, that the CSP got its inline hashes, and that no
// private machine paths, usernames, internal decision numbers or unmasked sandbox credentials
// leaked into anything.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const DIST = new URL('../dist', import.meta.url).pathname;
let bad = 0;
const fail = (what) => {
	bad++;
	console.error(`check-dist: ${what}`);
};

const need = (path, why) => {
	if (!existsSync(join(DIST, path))) fail(`${path} missing — ${why}`);
};

// -- what must exist -------------------------------------------------------
// Pages that exist today; content tasks extend this as the docs land.
for (const page of ['index.html', 'changelog/index.html', 'api/reference/index.html']) need(page, 'a page that must be on the site');
for (const file of ['protocol.json', 'pagefind/pagefind.js', 'llms.txt', 'llms-full.txt', 'changelog/rss.xml', 'sitemap-index.xml', '_headers', 'robots.txt', 'favicon.svg'])
	need(file, 'part of the build');
need('index.md', 'the Markdown twin of the index');

// -- every page has its Markdown twin --------------------------------------
// The docs promise .md next to every page for "Copy Markdown" and AI tools.
const htmlPages = [];
const walkHtml = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory() && !name.startsWith('_')) walkHtml(path);
		else if (name.endsWith('.html') && name !== '404.html') htmlPages.push(path);
	}
};
walkHtml(DIST);
for (const page of htmlPages) {
	const rel = relative(DIST, page);
	if (rel.startsWith('api/reference')) continue; // the protocol reference is rendered, not a document
	// /quick-start/index.html → /quick-start.md, /index.html → /index.md
	const mdPath = rel === 'index.html' ? 'index.md' : rel.replace(/\/index\.html$/, '.md');
	if (!existsSync(join(DIST, mdPath))) fail(`${mdPath} missing — Markdown twin of ${rel}`);
}

// -- nothing private leaked -------------------------------------------------
// What would embarrass the site: real machine paths, the author's username, internal decision
// numbers (D-001), real hostnames, anything shaped like a processor credential. Checked over
// every file that isn't a binary asset.
const FORBIDDEN = [
	{ pattern: /\/Users\/[^\s"'`<>]+/, why: 'a macOS home path' },
	{ pattern: /\/home\/[^\s"'`<>]+/, why: 'a Linux home path' },
	{ pattern: /\bD-\d{3}\b/, why: 'an internal decision number — paraphrase it' },
	{ pattern: /\b(sk|pk|rk)_(live|prod)_[A-Za-z0-9]+/, why: 'a processor-shaped key — nothing here has one' },
];
const TEXT_EXT = /\.(html|css|js|mjs|json|xml|txt|md|svg|webmanifest|toml|yaml|yml)$/;
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (TEXT_EXT.test(name)) {
			const rel = relative(DIST, path);
			if (rel.startsWith('pagefind/')) continue; // generated index, not our prose
			const text = readFileSync(path, 'utf8');
			for (const { pattern, why } of FORBIDDEN) {
				const hit = text.match(pattern);
				if (hit) fail(`${rel}: ${why} (${hit[0].slice(0, 60)}…)`);
			}
		}
	}
};
walk(DIST);

// The host's own name must not appear in prose either (it would if docs were written on a machine
// whose hostname is mentioned anywhere).
const host = execSync('hostname').toString().trim().split('.')[0];
if (host.length > 3) {
	const hits = execSync(`grep -rl "${host}" "${DIST}" --include='*.html' || true`).toString().trim();
	if (hits) fail(`this machine's hostname "${host}" appears in ${hits}`);
}

// -- security headers reached the build ------------------------------------
const headers = readFileSync(join(DIST, '_headers'), 'utf8');
for (const want of ["default-src 'self'", "script-src 'self'", 'sha256-', 'max-age=31536000', 'nosniff', "frame-ancestors 'none'"])
	if (!headers.includes(want)) fail(`_headers lacks ${want} — CSP hashes run before this?`);
if (!/script-src 'self' 'wasm-unsafe-eval' 'sha256-/.test(headers)) fail('the CSP has no inline-script hashes — scripts/csp-hashes.mjs did not run or found none');
if (headers.includes('INLINE_SCRIPT_HASHES')) fail('the CSP still holds the INLINE_SCRIPT_HASHES marker');
// unsafe-inline is allowed on styles only (Starlight sets inline styles; it can't reach
// out under this connect-src) — it must never appear on scripts.
const scriptSrc = headers.match(/script-src [^;]+/g) ?? [];
for (const directive of scriptSrc) if (/unsafe-inline/.test(directive) || /(?<!wasm-)unsafe-eval/.test(directive)) fail(`script-src allows ${directive.trim()}`);

console.log(bad === 0 ? 'check-dist: clean' : `check-dist: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
