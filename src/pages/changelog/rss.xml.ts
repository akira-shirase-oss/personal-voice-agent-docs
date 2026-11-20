import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { anchorOf, changes } from '../../lib/changelog';

/** The changelog as RSS: one item per entry, linking to its anchor, with the full text. */
export const GET: APIRoute = async ({ site }) => {
	const origin = site ?? new URL('https://docs.personal-voice-agent.404human.dev');
	const entries = await changes();
	return rss({
		title: 'Personal Voice Agent changelog',
		description: 'What changed in Personal Voice Agent, the simulated-money payment platform for development and CI: features, fixes, security fixes and breaking changes.',
		site: origin,
		items: entries.map((entry) => {
			const docs = entry.data.docs.map((link) => `<a href="${new URL(link.href, origin).href}">${link.label}</a>`).join(' · ');
			const html = (entry.rendered?.html ?? '').replace(/href="\/(?!\/)/g, `href="${origin.origin}/`);
			return {
				title: `${entry.data.type}: ${entry.data.title}`,
				link: new URL(`/changelog/#${anchorOf(entry)}`, origin).href,
				pubDate: entry.data.date,
				categories: [entry.data.type, ...entry.data.areas],
				content: docs ? `${html}<p>Read more: ${docs}</p>` : html,
			};
		}),
		customData: '<language>en-gb</language>',
	});
};
