// The privacy check end to end against a known-bad dist: fixtures/bad-dist
// ships a third-party image, a preconnect hint and a stray storage key written
// by an interaction the crawl performs. The run must exit 1 and each of the
// three problems must appear in its report — a check that misses any of them is
// a check that would pass a real leak.
//
// The run needs a real browser, which some sandboxes cannot launch; it reports
// itself skipped there rather than passing silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = new URL('..', import.meta.url).pathname;

test('the known-bad fixture fails the privacy run on each of its three planted problems', async (t) => {
	let browser;
	try {
		browser = await chromium.launch();
	} catch {
		t.skip('chromium cannot launch in this environment — run this where the privacy check runs');
		return;
	}
	await browser.close();

	const run = spawn(process.execPath, [join(ROOT, 'scripts', 'check-privacy.mjs'), '--pages', '/', '--dist', join(ROOT, 'fixtures', 'bad-dist')], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let out = '';
	run.stdout.on('data', (d) => (out += d));
	run.stderr.on('data', (d) => (out += d));
	const code = await new Promise((resolve) => run.on('exit', resolve));

	assert.equal(code, 1, `the fixture must fail the run, not pass it:\n${out}`);
	assert.match(out, /third-party request/, 'the off-site image is caught by the request trace');
	assert.match(out, /preconnect.*points off-site/, 'the preconnect hint is caught before any request exists');
	assert.match(out, /recent-searches.*reader data/, 'a stray storage key written by an interaction is caught on the tab that interacted');
});
