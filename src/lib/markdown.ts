/**
 * A docs page's source as plain Markdown, for "Copy Markdown", "View as Markdown" and AI tools.
 * Pages are MDX that uses a handful of Starlight components; each becomes its Markdown equivalent,
 * and the test-runner markers on code fences (`run=`, `output=`) are dropped.
 */
export function toMarkdown(title: string, description: string | undefined, body: string, url: string): string {
	let text = body
		// imports, exports and comments belong to MDX, not the reader
		.replace(/^import\s.*\sfrom\s+['"][^'"]+['"];?\s*$/gm, '')
		.replace(/^export\s+(const|let|function|default)\s.*$/gm, '')
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
		// Steps, Tabs and card grids are layout only
		.replace(/^\s*<\/?(Steps|Tabs|CardGrid)[^>]*>\s*$/gm, '')
		.replace(/^\s*<TabItem\s+label="([^"]+)"[^>]*>\s*$/gm, '**$1**\n')
		.replace(/^\s*<\/TabItem>\s*$/gm, '')
		// <LinkCard title="…" href="…" description="…" />
		.replace(/<LinkCard\s+([^>]*?)\/>/gs, (_match, attrs: string) => {
			const get = (name: string) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
			const description = get('description');
			return `- [${get('title') ?? ''}](${get('href') ?? ''})${description ? `: ${description}` : ''}`;
		})
		// <Badge text="…" /> becomes its words in brackets
		.replace(/<Badge\s+[^>]*text="([^"]+)"[^>]*\/>/g, '[$1]')
		// the runner's markers on code fences
		.replace(/^(\s*```[\w-]*)([^\n]*)$/gm, (_match, fence: string, meta: string) => {
			const kept = meta.replace(/\s*\b(run|output|hidden|step|file)=("[^"]*"|\S+)/g, '').trimEnd();
			return `${fence}${kept}`;
		})
		// links and images inside the site become absolute, so the copy works anywhere
		.replace(/\]\(\/(?!\/)/g, `](${new URL('/', url).origin}/`)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const head = [`# ${title}`, '', ...(description ? [`> ${description}`, ''] : []), `Source: ${url}`, ''];
	return `${head.join('\n')}\n${text}\n`;
}
