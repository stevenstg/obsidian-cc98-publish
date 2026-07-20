import type { ExportFormat } from "./settings";
import { markdownToUbb } from "./md-to-ubb";

export function formatExportBody(body: string, format: ExportFormat): string {
	return format === "ubb" ? markdownToUbb(body) : body;
}
