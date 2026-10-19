/**
 * Markdown → CC98 UBB
 *
 * Headings: #→7 ##→6 ###→5 ####→4 #####→3 ######→2
 * Emphasis via delimiter-aware scan (not naive chained regex).
 * Code regions: mapOutsideCode (fenced with indent, indented blocks, inline).
 */

import { mapLinkProse, prepareLinks, type LinkOptions } from "./links";

const HEADING_SIZE: Record<number, number> = {
	1: 7,
	2: 6,
	3: 5,
	4: 4,
	5: 3,
	6: 2,
};

export function headingSize(level: number): number {
	const n = Math.min(6, Math.max(1, level | 0));
	return HEADING_SIZE[n] ?? 2;
}

/**
 * Convert markdown body (after image URL rewrite) to UBB.
 */
export function markdownToUbb(md: string, options: LinkOptions = {}): string {
	const out = mapLinkProse(
		md,
		(chunk) => convertProseChunk(chunk, options),
		(chunk) => convertCodeSegment(chunk)
	);
	return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Inline `x` → "x"; fenced/indented code → dashed block. */
function convertCodeSegment(chunk: string): string {
	const t = chunk;
	if (!t.includes("\n")) {
		const m = t.trim().match(/^`+([\s\S]*?)`+$/);
		if (m) return `"${m[1]}"`;
	}
	const fence = t.match(
		/^[ \t]{0,3}(```|~~~)[^\n]*\r?\n([\s\S]*?)(?:\r?\n[ \t]{0,3}\1[^\n]*)?\s*$/
	);
	if (fence) {
		const body = fence[2].replace(/\n+$/, "");
		return `----------\n${body}\n-----------\n`;
	}
	const lines = t.split("\n");
	const stripped = lines
		.map((ln) => ln.replace(/^(?:    |\t)/, ""))
		.join("\n")
		.replace(/\n+$/, "");
	if (stripped) {
		return `----------\n${stripped}\n-----------\n`;
	}
	return t;
}

function convertProseChunk(text: string, options: LinkOptions): string {
	const links = prepareLinks(text, "ubb", options, (label) => convertProseChunk(label, {}));
	let t = links.text;

	// Headings
	t = t.replace(
		/^(#{1,6})\s+(.+?)\s*$/gm,
		(_m, hashes: string, title: string) => {
			const size = headingSize(hashes.length);
			return `[size=${size}]${title.trim()}[/size]`;
		}
	);

	// Alignment HTML (allow extra attrs)
	t = t.replace(
		/<(div|p)\b[^>]*\balign\s*=\s*["']?(left|center|right)["']?[^>]*>([\s\S]*?)<\/\1>/gi,
		(_m, _tag: string, align: string, inner: string) =>
			`[align=${align.toLowerCase()}]${inner.trim()}[/align]`
	);
	t = t.replace(
		/<center\b[^>]*>([\s\S]*?)<\/center>/gi,
		(_m, inner: string) => `[align=center]${inner.trim()}[/align]`
	);

	// HTML emphasis (allow attributes)
	t = t.replace(
		/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi,
		"[b]$2[/b]"
	);
	t = t.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, "[i]$2[/i]");
	t = t.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, "[u]$1[/u]");
	t = t.replace(
		/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi,
		"[del]$2[/del]"
	);

	// ++underline++ dialect
	t = t.replace(/\+\+(.+?)\+\+/g, "[u]$1[/u]");

	// ~~strike~~ before emphasis
	t = t.replace(/~~(.+?)~~/g, "[del]$1[/del]");

	// ==highlight==
	t = t.replace(/==([^=]+)==/g, "[b]$1[/b]");

	// Delimiter-aware * / _ emphasis (COR-01)
	t = convertMarkdownEmphasis(t);

	// Blockquote
	t = t.replace(/^>\s?/gm, "");

	// HR
	t = t.replace(/^(-{3,}|\*{3,}|_{3,})\s*$/gm, "----------");

	return links.restore(t);
}

/**
 * Convert **bold**, *italic*, ***both***, __bold__, _italic_.
 * Handles adjacent pairs and both nest directions (COR-01 / R3-C01).
 */
export function convertMarkdownEmphasis(text: string): string {
	let t = convertStarOrUnderscore(text, "*");
	t = convertStarOrUnderscore(t, "_");
	return t;
}

function countRun(text: string, i: number, d: string): number {
	let n = 0;
	while (i + n < text.length && text[i + n] === d) n++;
	return n;
}

/**
 * Recursive left-to-right matcher for delimiter d (* or _).
 */
function convertStarOrUnderscore(text: string, d: "*" | "_"): string {
	const out: string[] = [];
	let i = 0;
	const n = text.length;

	const isWord = (c: string) => /[A-Za-z0-9]/.test(c);

	while (i < n) {
		if (text[i] !== d) {
			out.push(text[i]);
			i++;
			continue;
		}
		let openRun = countRun(text, i, d);
		if (openRun > 3) {
			out.push(text.slice(i, i + openRun));
			i += openRun;
			continue;
		}

		// underscore: reject mid-word single open
		if (d === "_" && openRun === 1) {
			const before = i > 0 ? text[i - 1] : "";
			const after = i + 1 < n ? text[i + 1] : "";
			if (isWord(before) && isWord(after)) {
				out.push(d);
				i++;
				continue;
			}
		}

		const close = findMatchingClose(text, i + openRun, openRun, d);
		if (!close) {
			out.push(text[i]);
			i++;
			continue;
		}

		// slice inner and recurse
		let innerEnd = close.pos;
		let closeLen = close.len;
		let openUse = openRun;

		if (openUse === 3) {
			const inner = text.slice(i + 3, innerEnd);
			out.push(
				"[b][i]",
				convertStarOrUnderscore(inner, d),
				"[/i][/b]"
			);
		} else if (openUse === 2) {
			const inner = text.slice(i + 2, innerEnd);
			out.push("[b]", convertStarOrUnderscore(inner, d), "[/b]");
		} else {
			const inner = text.slice(i + 1, innerEnd);
			// underscore mid-word close
			if (d === "_" && openUse === 1) {
				const afterClose = innerEnd + closeLen < n ? text[innerEnd + closeLen] : "";
				const beforeClose = innerEnd > 0 ? text[innerEnd - 1] : "";
				if (isWord(beforeClose) && isWord(afterClose)) {
					out.push(d);
					i++;
					continue;
				}
			}
			out.push("[i]", convertStarOrUnderscore(inner, d), "[/i]");
		}
		i = innerEnd + closeLen;
	}
	return out.join("");
}

/**
 * Find close run for openRun, skipping balanced nested spans of other sizes.
 */
function findMatchingClose(
	text: string,
	from: number,
	openRun: number,
	d: string
): { pos: number; len: number } | null {
	let j = from;
	const n = text.length;
	while (j < n) {
		if (text[j] !== d) {
			j++;
			continue;
		}
		const run = countRun(text, j, d);
		if (run > 3) {
			j += run;
			continue;
		}

		if (openRun === 1) {
			if (run === 1) return { pos: j, len: 1 };
			if (run === 2) {
				// skip nested bold
				const nested = findMatchingClose(text, j + 2, 2, d);
				if (nested) {
					j = nested.pos + nested.len;
					continue;
				}
				j += run;
				continue;
			}
			if (run === 3) {
				// try skip nested bold starting as ** inside ***
				const nested = findMatchingClose(text, j + 2, 2, d);
				if (nested) {
					j = nested.pos + nested.len;
					continue;
				}
				// use only one delimiter as italic close (leave rest for outer)
				return { pos: j, len: 1 };
			}
		}

		if (openRun === 2) {
			if (run === 1) {
				const nested = findMatchingClose(text, j + 1, 1, d);
				if (nested) {
					j = nested.pos + nested.len;
					continue;
				}
				j += 1;
				continue;
			}
			// Prefer exact **; if *** leave one * for outer italic (e.g. *x **y***)
			if (run === 2) return { pos: j, len: 2 };
			if (run >= 3) return { pos: j, len: 2 };
		}

		if (openRun === 3) {
			if (run >= 3) return { pos: j, len: 3 };
			// skip smaller nested
			if (run === 1 || run === 2) {
				const nested = findMatchingClose(text, j + run, run, d);
				if (nested) {
					j = nested.pos + nested.len;
					continue;
				}
			}
			j += run;
			continue;
		}

		j += run;
	}
	return null;
}
