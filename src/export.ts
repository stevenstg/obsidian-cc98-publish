import type { ExportFormat } from "./settings";
import { markdownToUbb } from "./md-to-ubb";

export function formatExportBody(body: string, format: ExportFormat): string {
	return format === "ubb" ? markdownToUbb(body) : body;
}

export function hasUnresolvedLocalImages(body: string): boolean {
	return (
		/!\[[^\]]*\]\((?!\s*(?:https?:\/\/|data:))[^)]+\)/i.test(body) ||
		/!\[\[[^\]]+\]\]/.test(body) ||
		/\[img\](?!\s*(?:https?:\/\/|data:))[^[]+\[\/img\]/i.test(body)
	);
}
