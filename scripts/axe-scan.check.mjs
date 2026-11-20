#!/usr/bin/env node
// The accessibility scan, as a CI gate: loads each listed page in headless Chromium, injects
// axe-core, fails on any violation at WCAG 2.x A/AA or a best-practice rule.
//
//   node scripts/axe-scan.check.mjs                        every sitemap page on $PREVIEW
//   node scripts/axe-scan.check.mjs / /changelog/          these pages on $PREVIEW
//   node scripts/axe-scan.check.mjs http://127.0.0.1:58668 / /cli/   an explicit base
//
// The scan is only as good as the tool that runs it, so first it loads a page that is wrong on
// purpose — an image with no alt, a contrast failure — and asserts violations come back. If the
// scanner can't see those, it isn't scanning.
import { chromium } from '@playwright/test';
import axeScan from './axe-scan.mjs';
import sitemap from './lib/sitemap-pages.mjs';

const args = process.argv.slice(2);
const base = args[0]?.startsWith('http') ? args.shift() : (process.env.PREVIEW ?? 'http://127.0.0.1:58668');
const paths = args.length ? args : sitemap();

const browser = await chromium.launch();
const page = await browser.newPage();
let bad = 0;

// Self-test first: a page that must fail.
await page.setContent('<html><body><img src="x.png"><p style="color:#fff;background:#fff">invisible</p></body></html>');
const selfTest = await axeScan(page, { label: 'self-test' });
if (selfTest.length === 0) {
	console.error('axe: self-test failed — a page with no alt text and no contrast produced no violations; the scanner is not running');
	process.exit(1);
}

for (const path of paths) {
	const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
	if (!response?.ok()) {
		console.error(`axe: ${path} → HTTP ${response?.status()}`);
		bad++;
		continue;
	}
	await page.waitForTimeout(300);
	const violations = await axeScan(page, { label: path });
	if (violations.length === 0) {
		console.log(`axe: ${path} — clean`);
	} else {
		for (const v of violations) {
			console.error(`axe: ${path} — ${v.id} (${v.impact}): ${v.description}`);
			for (const target of v.nodes) console.error(`        ${target}`);
		}
		bad += violations.length;
	}
}

await browser.close();
console.log(bad === 0 ? `axe: ${paths.length} page(s) clean` : `axe: ${bad} violation(s)`);
process.exit(bad ? 1 : 0);
