import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';
import { toMarkdown } from '../lib/markdown';

/** Every docs page as Markdown at its own address plus `.md`: `/quick-start.md`, `/api/jobs.md`, `/index.md`. */
export const getStaticPaths = (async () => {
	const pages = await getCollection('docs');
	return pages.map((page) => ({ params: { slug: page.id }, props: { page } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: CollectionEntry<'docs'> }> = ({ props, site }) => {
	const { page } = props;
	const path = page.id === 'index' ? '/' : `/${page.id}/`;
	const url = new URL(path, site).href;
	return new Response(toMarkdown(page.data.title, page.data.description, page.body ?? '', url), {
		headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
	});
};
