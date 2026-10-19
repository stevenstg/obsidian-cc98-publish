import { splitMarkdownCode } from "./convert";

export interface LinkOptions {
	autoLinkWebUrls?: boolean;
}

type Format = "markdown" | "ubb";
interface Destination {
	url: string;
	end: number;
	tokenStart: number;
	tokenEnd: number;
}

/** Parse an inline destination without truncating balanced or escaped parentheses. */
function destination(text: string, open: number): Destination | null {
	if (text[open] !== "(") return null;
	let i = open + 1;
	while (/\s/.test(text[i] ?? "") && i < text.length) i++;
	const tokenStart = i;
	let raw = "";
	if (text[i] === "<") {
		i++;
		const start = i;
		while (i < text.length && text[i] !== ">") {
			if (text[i] === "\n" || text[i] === "\r") return null;
			if (text[i] === "\\") i++;
			i++;
		}
		if (text[i] !== ">") return null;
		raw = text.slice(start, i++);
	} else {
		const start = i;
		let depth = 0;
		while (i < text.length) {
			const c = text[i];
			if (c === "\\" && i + 1 < text.length) { i += 2; continue; }
			if (c === "(") depth++;
			if (c === ")") { if (!depth) break; depth--; }
			if (/\s/.test(c)) break;
			i++;
		}
		if (depth) return null;
		raw = text.slice(start, i);
	}
	const tokenEnd = i;
	while (i < text.length && /\s/.test(text[i])) i++;
	if (i > tokenEnd && /["'(]/.test(text[i] ?? "")) {
		const close = text[i] === "(" ? ")" : text[i];
		i++;
		while (i < text.length && text[i] !== close) {
			if (text[i] === "\\") i++;
			i++;
		}
		if (text[i++] !== close) return null;
		while (i < text.length && /\s/.test(text[i])) i++;
	}
	if (text[i] !== ")") return null;
	return { url: raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1"), end: i + 1, tokenStart, tokenEnd };
}

function labelEnd(text: string, start: number): number {
	let depth = 1;
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") { i++; continue; }
		if (text[i] === "[") depth++;
		if (text[i] === "]") { depth--; if (!depth) return i; }
	}
	return -1;
}

function webUrl(raw: string): string | null {
	if (!/^https?:\/\//i.test(raw)) return null;
	const encoded = raw.replace(/[\s<>"\[\]\\\x00-\x1f\x7f]/g, (c) => encodeURIComponent(c));
	try {
		const parsed = new URL(encoded);
		return parsed.hostname ? encoded : null;
	} catch { return null; }
}

function mediaTag(url: string): string | null {
	if (/^https?:\/\/(?:www\.)?bilibili\.com\/video\//i.test(url)) return "bili";
	if (/\.(mp4|webm|mov)(?:[?#].*)?$/i.test(url)) return "video";
	if (/\.(mp3|wav|ogg|m4a)(?:[?#].*)?$/i.test(url)) return "audio";
	return null;
}

function bareEnd(text: string, start: number): number {
	let i = start;
	let depth = 0;
	while (i < text.length && !/[\s<>"'`\[\]{}，。！？；：、（）“”‘’\uE100\uE101]/.test(text[i])) {
		if (text[i] === "(") depth++;
		if (text[i] === ")") { if (!depth) break; depth--; }
		i++;
	}
	while (i > start && /[.,;:!?*]/.test(text[i - 1])) i--;
	return i;
}

/** Shield URLs from subsequent UBB emphasis/media substitutions. Call on prose only. */
export function prepareLinks(text: string, format: Format, options: LinkOptions = {}, renderLabel: (label: string) => string = (label) => label): {
	text: string;
	restore: (converted: string) => string;
} {
	let prefix = "\uE000CC98LINK";
	while (text.includes(prefix)) prefix += "X";
	const values: string[] = [];
	const shield = (value: string) => `${prefix}${values.push(value) - 1}\uE001`;
	const link = (url: string, label: string) => format === "ubb"
		? `[url=${url}]${label}[/url]`
		: `[${label.replace(/([\\[\]])/g, "\\$1")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);
		if (text[i] === "\\" && i + 1 < text.length) {
			const close = text[i + 1] === "[" ? labelEnd(text, i + 1) : -1;
			const dest = close >= 0 ? destination(text, close + 1) : null;
			const end = dest ? dest.end : i + 2;
			out += shield(text.slice(i, end)); i = end; continue;
		}
		// Preserve existing UBB spans, including code and media, as indivisible units.
		const ubb = rest.match(/^\[(url(?:=[^\]\r\n]*)?|img|bili|video|audio|code)\][\s\S]*?\[\/(url|img|bili|video|audio|code)\]/i);
		if (ubb && ubb[1].split("=")[0].toLowerCase() === ubb[2].toLowerCase()) {
			out += shield(ubb[0]); i += ubb[0].length; continue;
		}
		// Reference definitions must not be turned into nested inline links.
		if ((i === 0 || text[i - 1] === "\n") && /^[ \t]{0,3}\[[^\]\n]+\]:/.test(rest)) {
			const end = text.indexOf("\n", i);
			const stop = end < 0 ? text.length : end;
			out += shield(text.slice(i, stop)); i = stop; continue;
		}
		const image = text[i] === "!" && text[i + 1] === "[";
		const start = image ? i + 1 : i;
		if (text[start] === "[") {
			const close = labelEnd(text, start);
			const dest = close >= 0 ? destination(text, close + 1) : null;
			if (dest) {
				const raw = text.slice(i, dest.end);
				const url = webUrl(dest.url);
				let result = raw;
				if (image && format === "ubb") result = `[img]${dest.url}[/img]`;
				else if (!image && url && format === "ubb") result = link(url, renderLabel(text.slice(start + 1, close)));
				else if (!image && url && format === "markdown" && options.autoLinkWebUrls && /\s/.test(dest.url)) {
					result = text.slice(i, dest.tokenStart) + url + text.slice(dest.tokenEnd, dest.end);
				}
				out += shield(result); i = dest.end; continue;
			}
			if (close >= 0 && text[close + 1] === "[") {
				const refEnd = labelEnd(text, close + 1);
				if (refEnd >= 0) {
					out += shield(text.slice(i, refEnd + 1)); i = refEnd + 1; continue;
				}
			}
		}
		if (text[i] === "<") {
			const auto = rest.match(/^<(https?:\/\/[^<>\s]+)>/i);
			if (auto && webUrl(auto[1])) {
				out += shield(format === "ubb" ? link(webUrl(auto[1])!, auto[1]) : auto[0]);
				i += auto[0].length; continue;
			}
			const html = rest.match(/^<\/?[a-z][^>]*>/i);
			if (html) { out += html[0]; i += html[0].length; continue; }
		}
		if (/^(https?:\/\/|www\.)/i.test(rest) && (i === 0 || !/[A-Za-z0-9_@/\\=.:%-]/u.test(text[i - 1]))) {
			const end = bareEnd(text, i);
			const raw = text.slice(i, end);
			const url = webUrl(/^www\./i.test(raw) ? `https://${raw}` : raw);
			if (url) {
				const media = format === "ubb" && /^https?:/i.test(raw) ? mediaTag(url) : null;
				const result = media ? `[${media}]${url}[/${media}]`
					: options.autoLinkWebUrls ? link(url, raw) : raw;
				out += shield(result); i = end; continue;
			}
		}
		out += text[i++];
	}
	return { text: out, restore: (converted) => converted.replace(new RegExp(`${prefix}(\\d+)\uE001`, "g"), (_m, n: string) => values[Number(n)]) };
}

export function normalizeMarkdownLinks(text: string, options: LinkOptions = {}): string {
	if (!options.autoLinkWebUrls) return text;
	return mapLinkProse(text, (chunk) => {
		const prepared = prepareLinks(chunk, "markdown", options);
		return prepared.restore(prepared.text);
	});
}

/** Keep inline code opaque without splitting a surrounding link label. */
export function mapLinkProse(
	text: string,
	prose: (chunk: string) => string,
	code: (chunk: string) => string = (chunk) => chunk
): string {
	let prefix = "\uE100CC98CODE";
	while (text.includes(prefix)) prefix += "X";
	const values: string[] = [];
	let buffer = "";
	let out = "";
	const flush = () => {
		if (!buffer) return;
		out += prose(buffer).replace(new RegExp(prefix + "(\\d+)\uE101", "g"),
			(_m, n: string) => values[Number(n)]);
		buffer = "";
	};
	for (const part of splitMarkdownCode(text)) {
		if (!part.code) buffer += part.text;
		else if (!part.text.includes("\n") && part.text.charCodeAt(0) === 96) {
			buffer += prefix + (values.push(code(part.text)) - 1) + "\uE101";
		} else {
			flush();
			out += code(part.text);
		}
	}
	flush();
	return out;
}
