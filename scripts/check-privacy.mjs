#!/usr/bin/env node
// The privacy check: what a reader's browser would actually do on the built site. It drives the
// pages in headless Chromium with the network fully traced, and fails if anything —
//
//   - leaves the machine for a third party on any page (fonts, CDNs, analytics, telemetry,
//     images from other hosts). These docs describe a local app; first-party only, no exceptions —
//     there is no hosted API to try and nothing may call out.
//   - persists anything that is not Starlight's own chrome state: the docs keep no reader data in
//     the browser. The only entries allowed are the two keys Starlight itself writes —
//     `starlight-theme` (the theme toggle) and `sl-sidebar-state` (which sidebar groups are
//     open) — both UI chrome, not data; anything else fails.
//   - sets a credential-named cookie or opens an IndexedDB database.
//
// It also runs the accessibility scan (scripts/axe-scan.mjs) on the pages it visits — the same
// browser, the same pass.
//
//   node scripts/check-privacy.mjs                          build is served by a spawned preview
//   node scripts/check-privacy.mjs --pages /,/api/reference/   just these pages
//   PREVIEW=http://127.0.0.1:58668 node scripts/check-privacy.mjs   against a preview already up
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import axeScan from './axe-scan.mjs';

const sitemap = (await import('./lib/sitemap-pages.mjs')).default;

const argPages = (() => {
	const at = process.argv.indexOf('--pages');
	return at === -1 ? null : process.argv[at + 1].split(',');
})();
const pages = argPages ?? sitemap();

let bad = 0;
const fail = (what) => {
	bad++;
	console.error(`privacy: ${what}`);
};

// A preview of dist/ to browse. With PREVIEW set the caller runs it; otherwise spawn one and
// wait for it to answer before driving the pages.
let preview = null;
let base = process.env.PREVIEW;
if (!base) {
	const port = 58_668;
	base = `http://127.0.0.1:${port}`;
	preview = spawn('npx', ['astro', 'preview', '--port', String(port), '--host', '127.0.0.1'], { stdio: 'ignore' });
	for (let i = 0; i < 100; i++) {
		const up = await fetch(base).then((r) => r.ok).catch(() => false);
		if (up) break;
		if (i === 99) {
			console.error('privacy: astro preview never came up');
			preview.kill();
			process.exit(1);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}
const own = new URL(base).host;
const ok = (url) => {
	const u = new URL(url);
	return u.host === own || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:');
};

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });

// Every request the browser makes, and who made it. Anything off this origin is a bug.
const requests = [];
await context.route('**/*', async (route) => {
	const url = route.request().url();
	const page = route.request().frame()?.page();
	requests.push({ url, page: page?.url() ?? '(no page)' });
	if (ok(url)) return route.continue();
	fail(`third-party request from ${page?.url() ?? '?'}: ${url}`);
	await route.abort();
});

const page = await context.newPage();
const axeBad = [];
for (const path of pages) {
	const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
	if (!response?.ok()) {
		fail(`${path} → HTTP ${response?.status()}`);
		continue;
	}
	await page.waitForTimeout(300);
	const violations = await axeScan(page, { label: path });
	if (violations.length) axeBad.push({ path, violations });
}

// Storage on the last page read whole: the two keys Starlight itself owns are fine (theme choice,
// which sidebar groups are open — chrome state, not reader data); nothing else may persist — no
// tokens, no server, no identity, because there is nothing to remember.
const STARLIGHT_KEYS = new Set(['starlight-theme', 'sl-sidebar-state']);
const storage = await page.evaluate(() => {
	const read = (area) => Object.fromEntries(Array.from({ length: area.length }, (_, i) => area.key(i)).map((name) => [name, area.getItem(name)]));
	return { localStorage: read(localStorage), sessionStorage: read(sessionStorage) };
});
for (const [area, entries] of Object.entries(storage)) {
	for (const name of Object.keys(entries)) {
		if (!STARLIGHT_KEYS.has(name)) fail(`${area} stores ${name} — the docs keep no reader data in the browser`);
	}
}
const cookies = await context.cookies();
if (cookies.length) fail('a cookie was set — the docs set none');
if ((await page.evaluate(async () => (await indexedDB.databases?.())?.length ?? 0)) > 0) fail('an IndexedDB database exists — nothing may persist');

for (const { path, violations } of axeBad) {
	for (const v of violations) console.error(`privacy/axe: ${path} — ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).join(', ')}`);
	bad += violations.length;
}

await browser.close();
preview?.kill();
console.log(bad === 0 ? `privacy: clean across ${pages.length} page(s)` : `privacy: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
