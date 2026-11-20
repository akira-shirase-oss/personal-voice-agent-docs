// The list of built pages the privacy and live checks walk. Reads dist/sitemap-index.xml → the
// site's own sitemap, and returns the paths. Used by check-privacy.mjs and check-live.mjs so a new
// page is checked automatically the day it lands.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../../dist', import.meta.url).pathname;

export default function sitemapPages() {
	const index = join(DIST, 'sitemap-index.xml');
	const file = existsSync(index) ? readFileSync(index, 'utf8') : '';
	const sub = file.match(/<loc>([^<]+)<\/loc>/g)?.map((loc) => loc.replace(/<\/?loc>/g, '')) ?? [];
	const urls = new Set();
	for (const loc of sub) {
		const path = new URL(loc).pathname;
		const local = join(DIST, path.replace(/^\//, ''));
		if (existsSync(local)) {
			for (const hit of readFileSync(local, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(new URL(hit[1]).pathname);
		}
	}
	// The reference and changelog are app-style pages that must be checked but render no sitemap entry
	// in some configs; include them when they exist.
	for (const extra of ['/api/reference/', '/changelog/']) {
		if (existsSync(join(DIST, extra.slice(1), 'index.html'))) urls.add(extra);
	}
	return [...urls].sort();
}
