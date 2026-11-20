import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/** The labels a changelog entry may carry. The page filters on these, so keep them short and stable. */
export const CHANGE_TYPES = ['Feature', 'Improvement', 'Fix', 'Security', 'Breaking', 'Deprecation'] as const;
export const CHANGE_AREAS = ['App', 'Session service', 'Protocol', 'Ledger', 'Consent', 'Store', 'Docs', 'Performance'] as const;

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),

	/**
	 * One file per changelog entry, named `YYYY-MM-DD-short-name.md`. The file name (without `.md`) is
	 * the entry's anchor on /changelog/, so never rename a published entry.
	 */
	changelog: defineCollection({
		loader: glob({ pattern: '**/[^_]*.md', base: './src/content/changelog' }),
		schema: z
			.object({
				title: z.string().min(8).max(110),
				/** The day the change reached `main` of personal-voice-agent (UTC). */
				date: z.coerce.date(),
				type: z.enum(CHANGE_TYPES),
				areas: z.array(z.enum(CHANGE_AREAS)).min(1),
				/** Where to read more, inside these docs. */
				docs: z
					.array(z.object({ label: z.string(), href: z.string().regex(/^\/[a-z0-9/#-]*$/) }))
					.default([]),
				/** Deprecations only: when it stops working, if a date has been set. */
				removal: z.coerce.date().optional(),
			})
			.strict(),
	}),
};
