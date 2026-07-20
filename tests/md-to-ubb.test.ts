import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headingSize, markdownToUbb } from "../src/md-to-ubb";

describe("headingSize (full H1–H6 ladder)", () => {
	it("maps all six levels to distinct size tags", () => {
		assert.equal(headingSize(1), 7);
		assert.equal(headingSize(2), 6); // ## 对照帖
		assert.equal(headingSize(3), 5);
		assert.equal(headingSize(4), 4);
		assert.equal(headingSize(5), 3);
		assert.equal(headingSize(6), 2);
	});
});

describe("markdownToUbb", () => {
	it("converts all heading levels", () => {
		const out = markdownToUbb(
			`# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n`
		);
		assert.ok(out.includes("[size=7]H1[/size]"));
		assert.ok(out.includes("[size=6]H2[/size]"));
		assert.ok(out.includes("[size=5]H3[/size]"));
		assert.ok(out.includes("[size=4]H4[/size]"));
		assert.ok(out.includes("[size=3]H5[/size]"));
		assert.ok(out.includes("[size=2]H6[/size]"));
	});

	it("converts bold italic underline strike (toolbar set)", () => {
		const out = markdownToUbb(
			[
				"**粗**",
				"*斜*",
				"~~删~~",
				"<u>下划</u>",
				"++下划2++",
				"<del>d</del>",
				"<s>s</s>",
				"***粗斜***",
			].join("\n")
		);
		assert.ok(out.includes("[b]粗[/b]"));
		assert.ok(out.includes("[i]斜[/i]"));
		assert.ok(out.includes("[del]删[/del]"));
		assert.ok(out.includes("[u]下划[/u]"));
		assert.ok(out.includes("[u]下划2[/u]"));
		assert.ok(out.includes("[del]d[/del]"));
		assert.ok(out.includes("[del]s[/del]"));
		assert.ok(out.includes("[b][i]粗斜[/i][/b]"));
	});

	it("handles adjacent and nested emphasis (COR-01 / R3-C01)", () => {
		const cases: Array<[string, string]> = [
			["*a* *b*", "[i]a[/i] [i]b[/i]\n"],
			["**bold *nested***", "[b]bold [i]nested[/i][/b]\n"],
			["*italic **bold***", "[i]italic [b]bold[/b][/i]\n"],
			["*a* ***b*** *c*", "[i]a[/i] [b][i]b[/i][/b] [i]c[/i]\n"],
			["*a **b** c*", "[i]a [b]b[/b] c[/i]\n"],
			["_a_ _b_", "[i]a[/i] [i]b[/i]\n"],
			["__bold _nested___", "[b]bold [i]nested[/i][/b]\n"],
		];
		for (const [input, expected] of cases) {
			assert.equal(markdownToUbb(input), expected);
		}
	});

	it("converts HTML em/strong/i/b", () => {
		const out = markdownToUbb(`<strong>S</strong> <em>E</em> <b>B</b> <i>I</i>\n`);
		assert.ok(out.includes("[b]S[/b]"));
		assert.ok(out.includes("[i]E[/i]"));
		assert.ok(out.includes("[b]B[/b]"));
		assert.ok(out.includes("[i]I[/i]"));
	});

	it("converts align HTML to [align]", () => {
		const out = markdownToUbb(
			`<div align="center">中</div>\n<p align="right">右</p>\n<center>C</center>\n`
		);
		assert.ok(out.includes("[align=center]中[/align]"));
		assert.ok(out.includes("[align=right]右[/align]"));
		assert.ok(out.includes("[align=center]C[/align]"));
	});

	it("converts md images to [img]", () => {
		const out = markdownToUbb(
			`![](https://file.cc98.org/v4-upload/d/x.webp)\n`
		);
		assert.ok(
			out.includes("[img]https://file.cc98.org/v4-upload/d/x.webp[/img]")
		);
	});

	it("converts links and media URLs", () => {
		const out = markdownToUbb(
			[
				`[点](https://www.cc98.org)`,
				`https://www.bilibili.com/video/BV1xx411c7mD`,
				`https://ex.com/a.mp4`,
				`https://ex.com/a.mp3`,
			].join("\n")
		);
		assert.ok(out.includes("[url=https://www.cc98.org]点[/url]"));
		assert.ok(out.includes("[bili]https://www.bilibili.com/video/BV1xx411c7mD[/bili]"));
		assert.ok(out.includes("[video]https://ex.com/a.mp4[/video]"));
		assert.ok(out.includes("[audio]https://ex.com/a.mp3[/audio]"));
	});

	it("converts inline code to double quotes (sample style)", () => {
		const out = markdownToUbb(
			`输入 \`npm install -g @anthropic-ai/claude-code\`\n`
		);
		assert.ok(out.includes('"npm install -g @anthropic-ai/claude-code"'));
	});

	it("converts fenced code to dashed blocks without inner transform", () => {
		const out = markdownToUbb("```\n**not bold**\n## not heading\n```\n");
		assert.ok(out.includes("----------"));
		assert.ok(out.includes("**not bold**"));
		assert.ok(out.includes("## not heading"));
		assert.ok(!out.includes("[size="));
	});

	it("keeps adjacent fenced blocks separate (R3-C03)", () => {
		assert.equal(
			markdownToUbb("```\na\n```\n```\nb\n```\n"),
			"----------\na\n-----------\n----------\nb\n-----------\n"
		);
	});

	it("strips blockquote markers like sample", () => {
		const out = markdownToUbb(`> 引用一行\n`);
		assert.ok(out.includes("引用一行"));
		assert.ok(!out.trimStart().startsWith(">"));
	});

	it("converts highlight leftovers", () => {
		const out = markdownToUbb(`==高亮==\n`);
		assert.ok(out.includes("[b]高亮[/b]"));
	});
});
