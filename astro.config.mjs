// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import { focusableCode } from './src/lib/focusable-code.mjs';

// The one place the public address lives: canonical URLs, the sitemap, llms.txt and the changelog feed derive from it.
const site = 'https://docs.personal-voice-agent.404human.dev';
const repo = 'https://github.com/akira-shirase-oss/personal-voice-agent-docs';

export default defineConfig({
	site,
	trailingSlash: 'always',
	output: 'static',
	integrations: [
		starlight({
			title: 'Personal Voice Agent Docs',
			description:
				'Documentation for Personal Voice Agent, the private on-device voice interface for macOS: quick start, consent and permissions, the session protocol, and operating the data directory.',
			favicon: '/favicon.svg',
			social: [
				{ icon: 'github', label: 'Personal Voice Agent on GitHub', href: 'https://github.com/akira-shirase-oss/personal-voice-agent' },
			],
			editLink: { baseUrl: `${repo}/edit/main/` },
			lastUpdated: true,
			pagination: true,
			credits: false,
			titleDelimiter: '·',
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			customCss: ['./src/styles/theme.css'],
			head: [
				{ tag: 'link', attrs: { rel: 'alternate', type: 'application/rss+xml', title: 'Personal Voice Agent changelog', href: `${site}/changelog/rss.xml` } },
				// An accessibility fix to Starlight's output: the search button shows "Search" and its
				// shortcut (⌘K or Ctrl K), so its name says both, as speech input reads them (WCAG 2.5.3).
				// Starlight swaps ⌘ for Ctrl off a Mac, sometimes after this runs, so the name follows
				// the shortcut's text whenever it changes; and a space separates the visible words
				// ("Search Ctrl K", not "SearchCtrlK"), so the name contains what is shown.
				// (Wide tables and code blocks take keyboard focus from the build instead, WCAG 2.1.1:
				// src/lib/focusable-code.mjs and scripts/focusable-tables.mjs, so they do without JavaScript too.)
				{
					tag: 'script',
					content:
						"document.addEventListener('DOMContentLoaded',()=>{for(const b of document.querySelectorAll('button[data-open-modal]')){const n=()=>{const p=[b.querySelector('span'),...b.querySelectorAll('kbd kbd')];for(const e of p.slice(0,-1))if(e&&e.nextSibling?.nodeValue!==' ')e.after(' ');const k=[...b.querySelectorAll('kbd kbd')].map(e=>e.textContent.trim()).join(' ');if(k)b.setAttribute('aria-label','Search '+k)};n();const s=b.querySelector('kbd');if(s)new MutationObserver(n).observe(s,{subtree:true,childList:true,characterData:true})}});",
				},
			],
			expressiveCode: {
				plugins: [focusableCode()],
				themes: ['github-dark-default', 'github-light-default'],
				styleOverrides: {
					borderRadius: '0.5rem',
				},
			},
			components: {
				PageTitle: './src/components/PageTitle.astro',
				Footer: './src/components/Footer.astro',
			},
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'Introduction', slug: 'index' },
						{ label: 'Quick start', slug: 'quick-start' },
						{ label: 'Concepts', slug: 'concepts' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Consent and permissions', slug: 'consent-and-permissions' },
						{ label: 'A turn, end to end', slug: 'a-turns-life' },
					],
				},
				{
					label: 'Operating',
					items: [
						{ label: 'The data directory', slug: 'operating/data-directory' },
						{ label: 'Retention, deletion, backups', slug: 'operating/retention-and-backups' },
						{ label: 'Reliability and recovery', slug: 'operating/reliability' },
					],
				},
				{ label: 'Protocol reference', link: '/api/reference/', attrs: { 'data-reference': '' } },
				{ label: 'Changelog', link: '/changelog/' },
			],
			plugins: [
				starlightLinksValidator({ errorOnLocalLinks: true, exclude: ['/api/reference/', '/changelog/', '/changelog/**'] }),
				starlightLlmsTxt({
					projectName: 'Personal Voice Agent',
					description:
						'Personal Voice Agent is a private, on-device voice interface for macOS: a Swift app hosts Apple Speech, FoundationModels and the system voice, and a Rust session service owns consent, deadlines, the ledger and every decision about what is spoken or executed. No audio is retained; nothing leaves the machine.',
				}),
			],
		}),
	],
});
