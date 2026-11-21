#!/usr/bin/env node
// The privacy check: what a reader's browser would actually do on the built site. It drives the
// pages in headless Chromium with the network fully traced, and fails if anything —
//
//   - leaves the machine for a third party on any page: fonts, CDNs, analytics, telemetry,
//     images from other hosts, but also preconnect and dns-prefetch hints, prefetch targets,
//     and service workers — anything the route trace cannot see. These docs describe a local
//     app; first-party only, no exceptions.
//   - persists anything that is not Starlight's own chrome state: the docs keep no reader data
//     in the browser. Each allowed key is pinned to its storage area and to the value shape
//     Starlight writes — `starlight-theme` only in localStorage, only "light"/"dark"/""; and
//     `sl-sidebar-state` only in sessionStorage, only its {hash, open map, scroll} JSON.
//   - sets a credential-named cookie, opens an IndexedDB database, or registers a service
//     worker.
//   - is served without the real security headers: the site is served by scripts/serve-dist.mjs,
//     which applies dist/_headers the way Cloudflare does (astro preview does not), so the
//     CSP and Referrer-Policy under test are the deployed ones. The CSP is also probed in the
//     browser: an injected inline script must not run and a cross-origin fetch must never
//     reach the network.
//   - leaks a referrer: Referrer-Policy must be `no-referrer`, and an external link opening a
//     new context must carry `rel="noopener noreferrer"`.
//
// The crawl interacts, not just navigates: the theme is toggled, sidebar groups opened and
// closed, search is used, and copy buttons are pressed — then storage, cookies and the request
// log are checked again, because state written by an interaction counts the same.
//
// It also runs the accessibility scan (scripts/axe-scan.mjs) on the pages it visits — in a
// second context with CSP bypassed, because axe injects as an inline script and the site's
// script-src rightly refuses it. The privacy context never bypasses: the policy under test
// is never the weakened one.
//
//   node scripts/check-privacy.mjs                          build is served by a spawned static server
//   node scripts/check-privacy.mjs --pages /,/api/reference/   just these pages
//   PREVIEW=http://127.0.0.1:58668 node scripts/check-privacy.mjs   against a server already up
import { chromium } from '@playwright/test';
import axeScan from './axe-scan.mjs';
import { storageVerdict } from './lib/allowed-storage.mjs';
import { spawnDistServer, verifyNonce } from './lib/preview-server.mjs';
import { isCspRefusal } from './lib/csp-probe.mjs';
import { privacyContextOptions, axeContextOptions } from './lib/browser-contexts.mjs';

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

// A server for dist/ to browse. With PREVIEW set the caller runs it (a live deploy sends its
// own real headers); otherwise spawn scripts/serve-dist.mjs on a free port with a per-run
// nonce — and verify the answering server echoes it before a page loads. A pre-existing
// listener is never trusted: whatever else answers, it is not this run's spawn.
let preview = null;
let base = process.env.PREVIEW;
if (!base) {
	const { proc, base: spawned, nonce } = spawnDistServer(new URL('./serve-dist.mjs', import.meta.url).pathname);
	base = await spawned;
	if (!(await verifyNonce(base, nonce))) {
		proc.kill();
		console.error(`privacy: no response echoes this run's nonce — refusing to browse ${base}`);
		process.exit(1);
	}
	preview = proc;
}
const own = new URL(base).host;
const ok = (url) => {
	const u = new URL(url);
	return u.host === own || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:');
};

const browser = await chromium.launch();
// The privacy context keeps the site's real CSP — it is the subject of this check.
const context = await browser.newContext(privacyContextOptions());
// The axe context bypasses the CSP so axe-core's inline injection can run; nothing
// privacy-relevant happens in it.
const axeContext = await browser.newContext(axeContextOptions());

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

// A service worker would keep running after the page closes; the docs ship none, and any
// registration — own origin or not — is a bug.
context.on('serviceworker', (worker) => fail(`a service worker registered: ${worker.url()}`));

// Resource hints and service workers are how a page phones home without a fetch the trace can
// see — the browser resolves preconnect and dns-prefetch before any request exists.
const checkHints = async (page, path) => {
	const hints = await page.$$eval('link[rel]', (els) => els.map((l) => ({ rel: l.rel, href: l.href })));
	for (const { rel, href } of hints) {
		if (['preconnect', 'dns-prefetch', 'prefetch', 'prerender', 'preload', 'modulepreload'].includes(rel) && href && !ok(href)) {
			fail(`${path}: <link rel="${rel}"> points off-site: ${href}`);
		}
	}
	if ((await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length ?? 0)) > 0) {
		fail(`${path}: a service worker is registered — the docs ship none`);
	}
};

// External links that open a new context may keep no handle and send no referrer; same-tab
// external links are covered by the page's Referrer-Policy instead.
const checkExternalLinks = async (page, path) => {
	const links = await page.$$eval('a[href^="http"]', (els) => els.map((a) => ({ href: a.href, rel: a.rel, target: a.target })));
	for (const a of links) {
		if (new URL(a.href).host === own) continue;
		if (a.target === '_blank' && !(a.rel.includes('noopener') && a.rel.includes('noreferrer'))) {
			fail(`${path}: external link opens a new context without noopener noreferrer: ${a.href}`);
		}
	}
};

// Interactions count as much as navigations: theme, sidebar groups and copy buttons are the
// site's own writers, and anything they store lands in the storage read below.
const interact = async (page) => {
	const theme = page.locator('starlight-theme-select select').first();
	if (await theme.count()) {
		const now = await theme.inputValue();
		await theme.selectOption(now === 'dark' ? 'light' : 'dark');
		await page.waitForTimeout(50);
	}
	const group = page.locator('#starlight__sidebar details summary').first();
	if (await group.count()) {
		// A group can be present but hidden (a page without its sidebar); the
		// bounded click skips it rather than stalling the crawl.
		await group.click({ timeout: 2_000 }).catch(() => {});
		await page.waitForTimeout(50);
		await group.click({ timeout: 2_000 }).catch(() => {});
		await page.waitForTimeout(50);
	}
	for (const sel of ['div.copy button', '.page-action[data-copy-md]']) {
		const button = page.locator(sel).first();
		if (await button.count()) await button.click({ timeout: 2_000 }).catch(() => {});
		await page.waitForTimeout(50);
	}
};

const page = await context.newPage();
const axePage = await axeContext.newPage();
const axeBad = [];
for (const path of pages) {
	const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
	if (!response?.ok()) {
		fail(`${path} → HTTP ${response?.status()}`);
		continue;
	}
	const headers = response.headers();
	// The real headers are the check's subject — with PREVIEW set they are whatever that
	// server sends, which for a deploy is the deployed set.
	if (!headers['content-security-policy']) fail(`${path}: no Content-Security-Policy header — dist/_headers is not applied`);
	if (headers['referrer-policy'] !== 'no-referrer') fail(`${path}: Referrer-Policy "${headers['referrer-policy'] ?? '(none)'}" — the docs send no-referrer`);
	await page.waitForTimeout(300);
	await checkHints(page, path);
	await checkExternalLinks(page, path);
	await interact(page);
	await axePage.goto(`${base}${path}`, { waitUntil: 'networkidle' });
	const violations = await axeScan(axePage, { label: path });
	if (violations.length) axeBad.push({ path, violations });
}

// Search is heavy enough to exercise once: opening it loads Pagefind (wasm, 'wasm-unsafe-eval'
// in the CSP), and typing a query pulls the index — every request through the same route.
const first = await context.newPage();
await first.goto(`${base}${pages[0] ?? '/'}`, { waitUntil: 'domcontentloaded' });
const searchButton = first.locator('button[data-open-modal]').first();
if (await searchButton.count()) {
	await searchButton.click();
	const box = first.locator('dialog input[type="search"], dialog .pagefind-ui__search-input').first();
	try {
		await box.waitFor({ timeout: 5_000 });
		await box.fill('consent');
		await first.waitForTimeout(400);
	} catch {
		fail('the search dialog did not open an input — search may be broken');
	}
	await first.keyboard.press('Escape');
}

// CSP, probed in the browser rather than trusted from the header alone: an inline script the
// page never shipped must not run (script-src allows only the hashed ones), and a fetch off
// this origin must die in the renderer — if it reached the network the request log would show
// it. The refusal can arrive two ways — the probe's own verdict, or Playwright surfacing the
// CSP violation as an evaluation error; both are the expected outcome, anything else is not.
let scriptRan;
try {
	scriptRan = await first.evaluate(() => {
		window.__privacyProbe = 0;
		const s = document.createElement('script');
		s.textContent = 'window.__privacyProbe = 1';
		document.head.append(s);
		return window.__privacyProbe;
	});
} catch (err) {
	scriptRan = isCspRefusal(err) ? 0 : 1;
}
if (scriptRan !== 0) fail('CSP script-src did not stop an injected inline script');
const seen = requests.length;
let connectBlocked;
try {
	const leaked = await first.evaluate(async () => {
		try {
			await fetch('https://privacy.invalid/probe', { mode: 'no-cors' });
			return true;
		} catch {
			return false;
		}
	});
	connectBlocked = !leaked;
} catch (err) {
	connectBlocked = isCspRefusal(err);
}
if (!connectBlocked || requests.length !== seen) fail('CSP connect-src did not stop a cross-origin fetch');

// Storage, read whole after every interaction: the two keys Starlight itself owns, each in its
// own area and in the shape Starlight writes — nothing else may persist, and even they may not
// turn into something that is not chrome state.
const storage = await first.evaluate(() => {
	const read = (area) => Object.fromEntries(Array.from({ length: area.length }, (_, i) => area.key(i)).map((name) => [name, area.getItem(name)]));
	return { localStorage: read(localStorage), sessionStorage: read(sessionStorage) };
});
for (const [area, entries] of Object.entries(storage)) {
	for (const [name, value] of Object.entries(entries)) {
		const verdict = storageVerdict(area, name, value);
		if (verdict) fail(verdict);
	}
}
const cookies = await context.cookies();
if (cookies.length) fail('a cookie was set — the docs set none');
if ((await first.evaluate(async () => (await indexedDB.databases?.())?.length ?? 0)) > 0) fail('an IndexedDB database exists — nothing may persist');
if (context.serviceWorkers().length) fail('a service worker registered — the docs ship none');

for (const { path, violations } of axeBad) {
	for (const v of violations) console.error(`privacy/axe: ${path} — ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).join(', ')}`);
	bad += violations.length;
}

await browser.close();
preview?.kill();
console.log(bad === 0 ? `privacy: clean across ${pages.length} page(s)` : `privacy: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
