import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatExportBody } from "../src/export";

const enabled = { autoLinkWebUrls: true };
const ubb = (input: string, on = false) => formatExportBody(input, "ubb", { autoLinkWebUrls: on }).trimEnd();
const md = (input: string, on = true) => formatExportBody(input, "markdown", { autoLinkWebUrls: on });

describe("web link export", () => {
	const explicitCases = [
		['[官网](https://example.com)', '[url=https://example.com]官网[/url]'],
		['[https://example.com](https://example.com)', '[url=https://example.com]https://example.com[/url]'],
		['<https://example.com>', '[url=https://example.com]https://example.com[/url]'],
		['[括号](https://example.com/a(b))', '[url=https://example.com/a(b)]括号[/url]'],
		['[嵌套](https://example.com/a(b(c)))', '[url=https://example.com/a(b(c))]嵌套[/url]'],
		['[空格](<https://example.com/a b>)', '[url=https://example.com/a%20b]空格[/url]'],
		['[标题](https://example.com "悬停")', '[url=https://example.com]标题[/url]'],
		["[标题](https://example.com '悬停')", '[url=https://example.com]标题[/url]'],
		['[标题](https://example.com (悬停))', '[url=https://example.com]标题[/url]'],
		['[转义](https://example.com/a\\(b\\))', '[url=https://example.com/a(b)]转义[/url]'],
	];
	for (const [input, expected] of explicitCases) {
		it(`repairs explicit link independently of switch: ${input}`, () => {
			assert.equal(ubb(input), expected);
			assert.equal(ubb(input, true), expected);
			assert.equal(md(input, false), input);
		});
	}
	it("keeps bare web linking opt-in in both formats", () => {
		const input = 'https://example.com www.example.com';
		assert.equal(formatExportBody(input, 'markdown'), input);
		assert.equal(ubb(input), input);
		assert.equal(md(input), '[https://example.com](https://example.com) [www.example.com](https://www.example.com)');
		assert.equal(ubb(input, true), '[url=https://example.com]https://example.com[/url] [url=https://www.example.com]www.example.com[/url]');
	});
	it("preserves Markdown labels and titles, encoding only spaces in targets", () => {
		const input = '[官网](https://example.com "悬停")';
		assert.equal(md(input), input);
		assert.equal(md('[空格](<https://example.com/a b> "提示")'), '[空格](https://example.com/a%20b "提示")');
	});
	it("leaves Chinese and English punctuation outside URLs", () => {
		assert.equal(ubb('网址：https://example.com/a(b)，以及（www.example.com）。', true), '网址：[url=https://example.com/a(b)]https://example.com/a(b)[/url]，以及（[url=https://www.example.com]www.example.com[/url]）。');
		assert.equal(ubb('(https://example.com/a(b)).', true), '([url=https://example.com/a(b)]https://example.com/a(b)[/url]).');
		assert.equal(ubb('见https://example.com。', true), '见[url=https://example.com]https://example.com[/url]。');
	});
	it("does not rewrite URL delimiters as emphasis and preserves label emphasis", () => {
		assert.equal(ubb('[**官网**](https://example.com/a*b*c?q=__x__)'), '[url=https://example.com/a*b*c?q=__x__][b]官网[/b][/url]');
		assert.equal(ubb('**https://example.com**', true), '[b][url=https://example.com]https://example.com[/url][/b]');
	});
	it("leaves existing UBB links and images intact without nesting", () => {
		for (const input of ['[url=https://example.com]https://example.com[/url]', '[url]https://example.com[/url]', '[img]https://example.com/a*b*c.png[/img]']) {
			assert.equal(ubb(input, true), input);
			assert.equal(md(input), input);
		}
		assert.equal(md('![https://example.com](https://example.com/a.png)'), '![https://example.com](https://example.com/a.png)');
		assert.equal(ubb('![https://example.com](https://example.com/a*b*c.png)', true), '[img]https://example.com/a*b*c.png[/img]');
	});
	it("skips code regions including indented blocks", () => {
		const input = '`https://example.com`\n\n```md\n[官网](https://example.com)\n```\n\n    https://example.com\n';
		assert.equal(md(input), input);
		assert.equal(ubb(input, true), ubb(input));
		assert.ok(!ubb(input, true).includes('[url'));
	});
	it("keeps media priority for bare URLs, but explicit media links stay links", () => {
		for (const [url, tag] of [['https://www.bilibili.com/video/BV123', 'bili'], ['https://example.com/a.mp4', 'video'], ['https://example.com/a.mp3', 'audio']]) {
			assert.equal(ubb(url, true), `[${tag}]${url}[/${tag}]`);
			assert.equal(ubb(url), `[${tag}]${url}[/${tag}]`);
			assert.equal(ubb(`[播放](${url})`, true), `[url=${url}]播放[/url]`);
			assert.equal(md(url), `[${url}](${url})`);
		}
	});
	it("does not manufacture links for local paths or other schemes", () => {
		for (const input of ['[本地](notes/a.md)', '[邮件](mailto:a@example.com)', '[脚本](javascript:alert(1))', 'file:///tmp/www.example.com', 'user@www.example.com']) {
			assert.equal(md(input), input);
			assert.equal(ubb(input, true), input);
		}
	});
	it("does not double-wrap links on repeated conversion", () => {
		const input = '官网 https://example.com/a(b) 和 www.example.com';
		for (const format of ['markdown', 'ubb'] as const) {
			const once = formatExportBody(input, format, enabled);
			assert.equal(formatExportBody(once, format, enabled), once);
		}
	});
	it("does not alter Markdown reference definitions or HTML attributes", () => {
		const input = '[说明][ref]\n\n[ref]: https://example.com "悬停"\n<a href="https://example.com">官网</a>';
		assert.equal(md(input), input);
	});
	it("protects escaped brackets and respects even backslashes", () => {
		const input = String.raw`\[官网](https://example.com)`;
		assert.equal(ubb(input), input);
		assert.equal(ubb(input, true), input);
		assert.equal(md(input), input);
		assert.equal(ubb(String.raw`\\[官网](https://example.com)`), String.raw`\\[url=https://example.com]官网[/url]`);
	});
	it("protects full and collapsed reference links and images", () => {
		for (const label of ['[https://example.com][ref]', '[https://example.com][]', '![https://example.com][ref]']) {
			const input = label + '\n\n[ref]: https://target.example';
			assert.equal(md(input), input);
			assert.equal(ubb(input, true), input);
		}
	});
	it("converts links containing inline code without linking the code itself", () => {
		const input = '[use `x` and `https://example.org`](https://example.com)';
		assert.equal(md(input), input);
		assert.equal(ubb(input, true), '[url=https://example.com]use "x" and "https://example.org"[/url]');
		assert.equal(ubb(input), '[url=https://example.com]use "x" and "https://example.org"[/url]');
	});
	it("avoids collisions with placeholder-like user text", () => {
		const text = '\uE000CC98LINK0\uE001 https://example.com';
		assert.equal(ubb(text, true), '\uE000CC98LINK0\uE001 [url=https://example.com]https://example.com[/url]');
	});
});
