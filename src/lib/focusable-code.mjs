// Every code block can be reached and scrolled from the keyboard, with or without JavaScript
// (WCAG 2.1.1; axe's scrollable-region-focusable): its <pre> takes focus, shows the focus ring
// (src/styles/theme.css), and is a named region so a screen reader says what was focused.
// Set when the page is built, so it holds for readers without JavaScript too.

/** An Expressive Code plugin: `pre` gets tabindex 0, role region and the name "Code example". */
export function focusableCode() {
	return {
		name: 'focusable-code',
		hooks: {
			postprocessRenderedBlock: ({ renderData }) => {
				const visit = (node) => {
					if (node.type === 'element' && node.tagName === 'pre') {
						node.properties = { ...node.properties, tabIndex: 0, role: 'region', ariaLabel: 'Code example' };
						return;
					}
					for (const child of node.children ?? []) visit(child);
				};
				visit(renderData.blockAst);
			},
		},
	};
}
