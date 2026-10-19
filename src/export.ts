import type { ExportFormat } from "./settings";
import { mapOutsideCode } from "./convert";
import { markdownToUbb } from "./md-to-ubb";

import { normalizeMarkdownLinks, type LinkOptions } from "./links";

export function formatExportBody(body: string, format: ExportFormat, options: LinkOptions = {}): string {
	return format === "ubb" ? markdownToUbb(body, options) : normalizeMarkdownLinks(body, options);
}

export function hasUnresolvedLocalImages(body: string): boolean {
	let found = false;
	mapOutsideCode(body, (text) => {
		found ||=
			/!\[[^\]]*\]\((?!\s*(?:https?:\/\/|data:))[^)]+\)/i.test(text) ||
			/!\[\[[^\]]+\]\]/.test(text) ||
			/\[img\](?!\s*(?:https?:\/\/|data:))[^[]+\[\/img\]/i.test(text);
		return text;
	});
	return found;
}
