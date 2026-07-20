/**
 * Pure Obsidian Markdown → CC98-ready Markdown conversion.
 * Image path rewriting is done separately (async upload).
 */

export interface ConvertOptions {
	stripFrontmatter?: boolean;
	stripFirstH1?: boolean;
	stripTags?: boolean;
}

export interface ConvertResult {
	/** Body ready for further image rewriting / paste. */
	body: string;
	/** First H1 or filename-derived title if any. */
	title: string;
	/** Local image/embed targets that still need upload or resolution. */
	localImageRefs: LocalImageRef[];
}

export interface LocalImageRef {
	/** Full match string in body before rewrite. */
	raw: string;
	/** Resolved path as written in markdown (relative or wiki target). */
	path: string;
	/** Kind of reference. */
	kind: "wiki-embed" | "md-image";
	/** Optional alt text for md images. */
	alt?: string;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FIRST_H1_RE = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/;
const WIKI_EMBED_RE = /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const COMMENT_RE = /%%[\s\S]*?%%/g;
const HIGHLIGHT_RE = /==([^=]+)==/g;
const CALLOUT_RE = /^>\s*\[!([^\]]+)\]\s*(.*)$/gm;

/** Only real image formats (COR-02). */
const UPLOADABLE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

export function isLocalImagePath(src: string): boolean {
	const s = src.trim().replace(/^<|>$/g, "");
	if (!s) return false;
	if (/^https?:\/\//i.test(s)) return false;
	if (/^data:/i.test(s)) return false;
	return true;
}

export function looksUploadable(path: string): boolean {
	return UPLOADABLE_EXT.test(path.trim());
}

/**
 * Split markdown into code / non-code segments.
 * Covers:
 * - fenced ```/~~~ with 0–3 leading spaces (CommonMark)
 * - indented code blocks (4 spaces or tab)
 * - inline code with any run of backticks
 * Unclosed fence → rest of document is code (conservative).
 */
export function splitMarkdownCode(
	md: string
): { code: boolean; text: string }[] {
	const parts: { code: boolean; text: string }[] = [];
	let i = 0;
	const n = md.length;

	const atLineStart = (pos: number): boolean =>
		pos === 0 || md[pos - 1] === "\n" || md[pos - 1] === "\r";

	/** Count leading spaces/tabs at pos if at line start; returns {spaces, next} */
	const leadingIndent = (
		pos: number
	): { spaces: number; next: number } | null => {
		if (!atLineStart(pos)) return null;
		let j = pos;
		let spaces = 0;
		while (j < n) {
			if (md[j] === " ") {
				spaces += 1;
				j++;
			} else if (md[j] === "\t") {
				spaces += 4;
				j++;
			} else break;
		}
		return { spaces, next: j };
	};

	/** Previous non-blank line content before pos (for list continuation). */
	const prevNonBlankLine = (pos: number): string => {
		let end = pos - 1;
		while (end >= 0 && (md[end] === "\n" || md[end] === "\r" || md[end] === " ")) {
			// skip trailing spaces on empty lines only when whole line blank
			end--;
		}
		// rewind over blank lines
		while (end >= 0) {
			// find line start
			let ls = end;
			while (ls > 0 && md[ls - 1] !== "\n") ls--;
			const line = md.slice(ls, end + 1);
			if (line.trim().length > 0) return line;
			// go to previous line
			end = ls - 1;
			if (end >= 0 && md[end] === "\n") end--;
		}
		return "";
	};

	const isListLine = (line: string): boolean =>
		/^\s*([-*+]|\d{1,9}[.)])(\s+|$)/.test(line);
	const listContentIndent = (line: string): number | null => {
		const m = line.match(/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/);
		if (!m) return null;
		let width = m[2].length;
		for (const ch of m[1] + (m[3] || " ")) width += ch === "\t" ? 4 : 1;
		return width;
	};

	/** True if 4-space indent here is list continuation, not a code block. */
	const isListContinuationIndent = (pos: number): boolean => {
		const currentIndent = leadingIndent(pos)?.spaces ?? 0;
		const prev = prevNonBlankLine(pos);
		if (!prev) return false;
		const prevContentIndent = listContentIndent(prev);
		if (prevContentIndent !== null) {
			return currentIndent < prevContentIndent + 4;
		}
		// previous line also indented (nested list / continuation)
		if (/^[ \t]+\S/.test(prev) && !/^[ \t]{0,3}(`{3,}|~{3,})/.test(prev)) {
			// if any ancestor list in recent lines
			let p = pos;
			for (let guard = 0; guard < 40; guard++) {
				const pl = prevNonBlankLine(p);
				if (!pl) return false;
				const contentIndent = listContentIndent(pl);
				if (contentIndent !== null) {
					return currentIndent < contentIndent + 4;
				}
				// move p to start of pl
				const idx = md.lastIndexOf(pl, p);
				if (idx <= 0) return false;
				p = idx;
			}
		}
		return false;
	};

	while (i < n) {
		// --- Fenced code with optional indent 0–3 ---
		const ind = leadingIndent(i);
		if (ind && ind.spaces <= 3) {
			const fencePos = ind.next;
			const ch = md[fencePos];
			if (
				(ch === "`" || ch === "~") &&
				md[fencePos + 1] === ch &&
				md[fencePos + 2] === ch
			) {
				let fenceLen = 0;
				while (
					fencePos + fenceLen < n &&
					md[fencePos + fenceLen] === ch
				)
					fenceLen++;
				if (fenceLen >= 3) {
					const start = i;
					let j = fencePos + fenceLen;
					while (j < n && md[j] !== "\n" && md[j] !== "\r") j++;
					if (md[j] === "\r") j++;
					if (md[j] === "\n") j++;
					let closed = false;
					while (j < n) {
						const lineInd = leadingIndent(j);
						const lineContent = lineInd ? lineInd.next : j;
						let k = 0;
						while (
							lineContent + k < n &&
							md[lineContent + k] === ch
						)
							k++;
						if (k >= fenceLen) {
							let end = lineContent + k;
							while (
								end < n &&
								(md[end] === " " || md[end] === "\t")
							)
								end++;
							if (
								end >= n ||
								md[end] === "\n" ||
								md[end] === "\r"
							) {
								if (md[end] === "\r") end++;
								if (md[end] === "\n") end++;
								parts.push({
									code: true,
									text: md.slice(start, end),
								});
								i = end;
								closed = true;
								break;
							}
						}
						while (j < n && md[j] !== "\n") j++;
						if (md[j] === "\n") j++;
					}
					if (!closed) {
						parts.push({ code: true, text: md.slice(start) });
						i = n;
					}
					continue;
				}
			}
		}

		// --- Indented code block: ≥4 spaces, NOT list continuation (R3-C02) ---
		if (ind && ind.spaces >= 4 && !isListContinuationIndent(i)) {
			// only if line has non-whitespace after indent
			let p = ind.next;
			if (p < n && md[p] !== "\n" && md[p] !== "\r") {
				const start = i;
				let j = i;
				while (j < n) {
					const li = leadingIndent(j);
					if (!li) break;
					// blank line continues indented block
					let q = li.next;
					const blank =
						q >= n || md[q] === "\n" || md[q] === "\r";
					if (!blank && li.spaces < 4) break;
					// list marker line ends code block
					const lineEnd = (() => {
						let e = j;
						while (e < n && md[e] !== "\n") e++;
						return md.slice(j, e);
					})();
					if (!blank && isListLine(lineEnd)) break;
					while (j < n && md[j] !== "\n") j++;
					if (md[j] === "\n") j++;
				}
				parts.push({ code: true, text: md.slice(start, j) });
				i = j;
				continue;
			}
		}

		// --- Inline code: any length run of backticks ---
		if (md[i] === "`") {
			let tick = 0;
			while (i + tick < n && md[i + tick] === "`") tick++;
			if (tick >= 1) {
				// if this is a fence attempt mid-line, treat as inline only if < 3
				// or always try find closing of same length
				const start = i;
				const open = tick;
				i += open;
				const closeSeq = "`".repeat(open);
				const close = md.indexOf(closeSeq, i);
				if (close === -1) {
					parts.push({ code: false, text: md[start] });
					i = start + 1;
					continue;
				}
				// closing must not be longer run of backticks
				let after = close + open;
				if (after < n && md[after] === "`") {
					// not a valid close of exact length; consume one and continue as text
					parts.push({ code: false, text: md[start] });
					i = start + 1;
					continue;
				}
				parts.push({ code: true, text: md.slice(start, after) });
				i = after;
				continue;
			}
		}

		// Free text until next potential code start
		const start = i;
		i++;
		while (i < n) {
			if (md[i] === "`") break;
			if (md[i] === "~" && atLineStart(i)) break;
			if (atLineStart(i)) {
				const li = leadingIndent(i);
				if (
					li &&
					li.spaces >= 4 &&
					!isListContinuationIndent(i)
				) {
					let q = li.next;
					if (q < n && md[q] !== "\n" && md[q] !== "\r") break;
				}
				if (li && li.spaces <= 3) {
					const fp = li.next;
					const ch = md[fp];
					if (
						(ch === "`" || ch === "~") &&
						md[fp + 1] === ch &&
						md[fp + 2] === ch
					)
						break;
				}
			}
			i++;
		}
		parts.push({ code: false, text: md.slice(start, i) });
	}

	return parts.filter((p) => p.text.length > 0);
}

export function mapOutsideCode(
	md: string,
	transform: (text: string) => string
): string {
	return splitMarkdownCode(md)
		.map((p) => (p.code ? p.text : transform(p.text)))
		.join("");
}

/**
 * Like mapOutsideCode but also transforms code segments (e.g. MD→UBB).
 */
export function mapOutsideCodeEx(
	md: string,
	onProse: (text: string) => string,
	onCode: (text: string) => string
): string {
	const segments = splitMarkdownCode(md);
	return segments
		.map((p) => (p.code ? onCode(p.text) : onProse(p.text)))
		.join("");
}

/** Extract code regions, run transform on non-code, restore. */
export function withCodeProtected(
	md: string,
	transform: (text: string) => string
): string {
	return mapOutsideCode(md, transform);
}

export function stripFrontmatter(md: string): string {
	return md.replace(FRONTMATTER_RE, "");
}

export function extractTitleAndMaybeStripH1(
	md: string,
	stripFirstH1: boolean
): { title: string; body: string } {
	const m = md.match(FIRST_H1_RE);
	if (!m) {
		return { title: "", body: md };
	}
	const title = m[1].trim();
	if (stripFirstH1) {
		return { title, body: md.replace(FIRST_H1_RE, "") };
	}
	return { title, body: md };
}

export function convertCallouts(md: string): string {
	return md.replace(CALLOUT_RE, (_full, type: string, title: string) => {
		const t = String(type).trim();
		const rest = String(title || "").trim();
		if (rest) return `> **${t}: ${rest}**`;
		return `> **${t}**`;
	});
}

export function convertHighlights(md: string): string {
	return md.replace(HIGHLIGHT_RE, "**$1**");
}

export function stripComments(md: string): string {
	return md.replace(COMMENT_RE, "");
}

export function convertWikilinks(md: string): string {
	return md.replace(
		WIKI_LINK_RE,
		(full, target: string, alias?: string, offset?: number, whole?: string) => {
			const idx = typeof offset === "number" ? offset : 0;
			const src = typeof whole === "string" ? whole : md;
			if (idx > 0 && src[idx - 1] === "!") {
				return full;
			}
			return (alias ?? target).trim();
		}
	);
}

export function stripHashTags(md: string): string {
	return md.replace(/(^|\s)#([A-Za-z0-9_\u4e00-\u9fff/-]+)(?=\s|$)/g, "$1");
}

/**
 * Parse destination of ![alt](dest) starting at open paren index.
 * Supports <path>, balanced parentheses, optional "title" or 'title'.
 */
export function parseMdImageDestination(
	src: string,
	openParenIdx: number
): { path: string; end: number } | null {
	// openParenIdx points at '('
	if (src[openParenIdx] !== "(") return null;
	let i = openParenIdx + 1;
	while (i < src.length && /\s/.test(src[i])) i++;
	if (i >= src.length) return null;

	if (src[i] === "<") {
		const close = src.indexOf(">", i + 1);
		if (close === -1) return null;
		const path = src.slice(i + 1, close);
		i = close + 1;
		while (i < src.length && /\s/.test(src[i])) i++;
		// optional title
		if (src[i] === '"' || src[i] === "'") {
			const q = src[i];
			i++;
			while (i < src.length && src[i] !== q) i++;
			if (i < src.length) i++;
		}
		while (i < src.length && /\s/.test(src[i])) i++;
		if (src[i] !== ")") return null;
		return { path: path.trim(), end: i + 1 };
	}

	// unquoted: read until space+quote title or balanced )
	let depth = 0;
	const start = i;
	while (i < src.length) {
		const c = src[i];
		if (c === "(") {
			depth++;
			i++;
			continue;
		}
		if (c === ")") {
			if (depth === 0) {
				const path = src.slice(start, i).trim();
				return { path, end: i + 1 };
			}
			depth--;
			i++;
			continue;
		}
		// space then title quote → end path
		if (/\s/.test(c) && depth === 0) {
			const path = src.slice(start, i).trim();
			while (i < src.length && /\s/.test(src[i])) i++;
			if (src[i] === '"' || src[i] === "'") {
				const q = src[i];
				i++;
				while (i < src.length && src[i] !== q) i++;
				if (i < src.length) i++;
			}
			while (i < src.length && /\s/.test(src[i])) i++;
			if (src[i] !== ")") return null;
			return { path, end: i + 1 };
		}
		i++;
	}
	return null;
}

export interface MdImageMatch {
	raw: string;
	alt: string;
	path: string;
	index: number;
}

/** Find all ![alt](dest) in string (does not skip code — call withOutsideCode separately). */
export function findMdImages(md: string): MdImageMatch[] {
	const out: MdImageMatch[] = [];
	let i = 0;
	while (i < md.length) {
		if (md[i] === "!" && md[i + 1] === "[") {
			const altStart = i + 2;
			let j = altStart;
			while (j < md.length && md[j] !== "]") j++;
			if (j >= md.length) break;
			const alt = md.slice(altStart, j);
			if (md[j + 1] !== "(") {
				i = j + 1;
				continue;
			}
			const dest = parseMdImageDestination(md, j + 1);
			if (!dest) {
				i = j + 1;
				continue;
			}
			const raw = md.slice(i, dest.end);
			out.push({ raw, alt, path: dest.path, index: i });
			i = dest.end;
			continue;
		}
		i++;
	}
	return out;
}

/**
 * Collect local image refs from non-code regions only.
 */
export function collectLocalImageRefs(md: string): LocalImageRef[] {
	const refs: LocalImageRef[] = [];
	const seen = new Set<string>();

	mapOutsideCode(md, (text) => {
		let m: RegExpExecArray | null;
		const wikiRe = new RegExp(WIKI_EMBED_RE.source, "g");
		while ((m = wikiRe.exec(text)) !== null) {
			const path = m[1].trim();
			const key = `wiki:${path}`;
			if (seen.has(key)) continue;
			if (/^https?:/i.test(path)) continue;
			if (!looksUploadable(path)) continue;
			seen.add(key);
			refs.push({
				raw: m[0],
				path,
				kind: "wiki-embed",
				alt: m[2]?.trim(),
			});
		}

		for (const img of findMdImages(text)) {
			const path = img.path.trim().replace(/^<|>$/g, "");
			if (!isLocalImagePath(path)) continue;
			if (!looksUploadable(path) && !/\./.test(path)) {
				// local path without known image ext — still try if has image-like path
			}
			// For md images, only upload known image extensions (or any local image path with image ext)
			if (!looksUploadable(path)) continue;
			const key = `md:${path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			refs.push({
				raw: img.raw,
				path,
				kind: "md-image",
				alt: img.alt,
			});
		}
		return text;
	});

	return refs;
}

/** How uploaded images are written into the paste body. */
export type ImageSyntax = "markdown" | "ubb";

export function formatImageTag(
	url: string,
	alt: string,
	syntax: ImageSyntax
): string {
	if (syntax === "ubb") {
		return `[img]${url}[/img]`;
	}
	return `![${alt}](${url})`;
}

/**
 * Rewrite known path → remote URL map into body (code protected).
 */
export function applyImageUrlMap(
	md: string,
	urlByPath: Map<string, string>,
	syntax: ImageSyntax = "markdown"
): string {
	return mapOutsideCode(md, (text) => {
		let out = text.replace(
			WIKI_EMBED_RE,
			(full, target: string, alias?: string) => {
				const path = String(target).trim();
				const url =
					urlByPath.get(path) ?? urlByPath.get(normalizePathKey(path));
				if (!url) return full;
				const alt = (alias ?? path).trim();
				return formatImageTag(url, alt, syntax);
			}
		);

		// Rewrite md images via scanner (stable under replacements from end)
		const matches = findMdImages(out);
		for (let k = matches.length - 1; k >= 0; k--) {
			const img = matches[k];
			const path = img.path.trim().replace(/^<|>$/g, "");
			if (!isLocalImagePath(path)) continue;
			const url =
				urlByPath.get(path) ?? urlByPath.get(normalizePathKey(path));
			if (!url) continue;
			const replacement = formatImageTag(url, img.alt, syntax);
			out =
				out.slice(0, img.index) +
				replacement +
				out.slice(img.index + img.raw.length);
		}
		return out;
	});
}

/**
 * Convert remote Markdown images to UBB [img] (outside code).
 */
export function convertRemoteMdImagesToUbb(md: string): string {
	return mapOutsideCode(md, (text) => {
		const matches = findMdImages(text);
		let out = text;
		for (let k = matches.length - 1; k >= 0; k--) {
			const img = matches[k];
			if (!/^https?:\/\//i.test(img.path.trim())) continue;
			const url = img.path.trim();
			const replacement = `[img]${url}[/img]`;
			out =
				out.slice(0, img.index) +
				replacement +
				out.slice(img.index + img.raw.length);
		}
		return out;
	});
}

export function normalizePathKey(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function transformProse(md: string, stripTags: boolean): string {
	return mapOutsideCode(md, (text) => {
		let t = stripComments(text);
		t = convertCallouts(t);
		t = convertHighlights(t);

		// Note embeds without image ext → plain text
		t = t.replace(WIKI_EMBED_RE, (full, target: string, alias?: string) => {
			const path = String(target).trim();
			if (looksUploadable(path)) return full;
			return (alias ?? target).trim();
		});

		t = convertWikilinks(t);
		if (stripTags) t = stripHashTags(t);
		return t;
	});
}

/**
 * Full sync conversion (no network). Local images remain as-is.
 */
export function convertMarkdown(
	input: string,
	options: ConvertOptions = {}
): ConvertResult {
	const opts: Required<ConvertOptions> = {
		stripFrontmatter: options.stripFrontmatter ?? true,
		stripFirstH1: options.stripFirstH1 ?? true,
		stripTags: options.stripTags ?? false,
	};

	let md = input.replace(/^\uFEFF/, "");
	if (opts.stripFrontmatter) {
		md = stripFrontmatter(md);
	}

	const { title, body: afterTitle } = extractTitleAndMaybeStripH1(
		md,
		opts.stripFirstH1
	);
	md = afterTitle;

	// Collect images before prose transform (embeds still present); code-safe
	const localImageRefs = collectLocalImageRefs(md);

	md = transformProse(md, opts.stripTags);

	md = md.replace(/\n{3,}/g, "\n\n").trim() + "\n";

	return { body: md, title, localImageRefs };
}

/** Placeholder rewrite when upload is skipped. */
export function materializeWikiEmbedsAsMd(md: string): string {
	return mapOutsideCode(md, (text) =>
		text.replace(WIKI_EMBED_RE, (full, target: string, alias?: string) => {
			const path = String(target).trim();
			if (!looksUploadable(path)) {
				return (alias ?? target).trim();
			}
			const alt = (alias ?? path).trim();
			return `![${alt}](${path})`;
		})
	);
}
