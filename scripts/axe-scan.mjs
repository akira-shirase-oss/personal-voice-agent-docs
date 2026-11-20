// Run by scripts/check-privacy.mjs inside the same Chromium context: it injects axe-core on the
// current page, runs WCAG 2.2 AA plus best practices, and writes the violations to /tmp/axe-out.json
// (or process.env.AXE_OUT). Kept separate so the scan can be reused standalone.
export default async function axeScan(page, { label = '', outFile = process.env.AXE_OUT ?? '/tmp/axe-out.json', include = ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] } = {}) {
	const { createRequire } = await import('node:module');
	const { writeFileSync } = await import('node:fs');
	const require = createRequire(import.meta.url);
	const axeSource = require.resolve('axe-core/axe.min.js');
	const { readFileSync } = await import('node:fs');
	await page.addScriptTag({ content: readFileSync(axeSource, 'utf8') });
	const results = await page.evaluate(async (tags) => {
		// @ts-expect-error injected above
		return await axe.run(document, { runOnly: { type: 'tag', values: tags } });
	}, include);
	// One readable shape for the file and the caller: rule, impact, and each element as its selector plus its markup.
	const violations = results.violations.map(({ id, impact, description, nodes }) => ({ id, impact, description, nodes: nodes.map((n) => `${JSON.stringify(n.target)} ${n.html.slice(0, 120)}`) }));
	writeFileSync(outFile, JSON.stringify({ label, url: page.url(), violations }, null, 2));
	return violations;
}
