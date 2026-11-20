import type { APIRoute } from 'astro';
import { anchorOf, byMonth, changes, dayOf } from '../lib/changelog';

/** The changelog as one Markdown file, for "Copy Markdown" and AI tools: the source of each entry, by month. */
export const GET: APIRoute = async ({ site }) => {
	const origin = (site ?? new URL('https://docs.personal-voice-agent.404human.dev')).origin;
	const lines = ['# Changelog', '', `Source: ${origin}/changelog/`, ''];
	for (const month of byMonth(await changes())) {
		lines.push(`## ${month.label}`, '');
		for (const entry of month.entries) {
			lines.push(`### ${entry.data.title}`, '', `${dayOf(entry.data.date)} · ${entry.data.type} · ${entry.data.areas.join(', ')} · ${origin}/changelog/#${anchorOf(entry)}`, '');
			lines.push((entry.body ?? '').trim().replace(/\]\(\/(?!\/)/g, `](${origin}/`), '');
			if (entry.data.docs.length > 0) lines.push(`Read more: ${entry.data.docs.map((link) => `[${link.label}](${origin}${link.href})`).join(' · ')}`, '');
		}
	}
	return new Response(`${lines.join('\n')}\n`, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
