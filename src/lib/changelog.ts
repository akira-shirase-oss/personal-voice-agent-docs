import { getCollection, type CollectionEntry } from 'astro:content';

export type Change = CollectionEntry<'changelog'>;

/** Newest first; entries on the same day keep a stable order by name. */
export async function changes(): Promise<Change[]> {
	const all = await getCollection('changelog');
	return all.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id));
}

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const monthOf = (date: Date) => MONTH.format(date);
export const dayOf = (date: Date) => DAY.format(date);
export const monthId = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

/** Group already-sorted entries by calendar month (UTC). */
export function byMonth(entries: Change[]): { id: string; label: string; entries: Change[] }[] {
	const months: { id: string; label: string; entries: Change[] }[] = [];
	for (const entry of entries) {
		const id = monthId(entry.data.date);
		let month = months.at(-1);
		if (month?.id !== id) {
			month = { id, label: monthOf(entry.data.date), entries: [] };
			months.push(month);
		}
		month.entries.push(entry);
	}
	return months;
}

/** The anchor of an entry on /changelog/: its file name without the extension. */
export const anchorOf = (entry: Change) => entry.id.replace(/\.md$/, '').split('/').pop() ?? entry.id;

/**
 * An entry's first sentence as plain text, for its card's one-line summary: the Markdown body's
 * first paragraph, with links, code, emphasis and markup reduced to their text.
 */
export function summaryOf(entry: Change): string {
	const paragraph = (entry.body ?? '').trim().split(/\n\s*\n/)[0] ?? '';
	const text = paragraph
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
		.replace(/\*([^*]+)\*|_([^_]+)_/g, '$1$2')
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	// The first sentence: up to the first full stop, question or exclamation mark that ends a word
	// and is followed by a space and a capital (so "e.g." and "v1.2" don't end it).
	const end = text.search(/[.!?](?=\s+[A-Z(“"@`])/);
	return end === -1 ? text : text.slice(0, end + 1);
}
