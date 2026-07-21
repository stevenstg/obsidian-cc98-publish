import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	convertMarkdown,
	applyImageUrlMap,
	collectLocalImageRefs,
	materializeWikiEmbedsAsMd,
	parseMdImageDestination,
	findMdImages,
	mapOutsideCode,
} from "../src/convert";
import {
	shouldFailFastUpload,
	shouldRetryUpload,
} from "../src/upload-policy";

describe("convertMarkdown", () => {
	it("strips frontmatter and first h1", () => {
		const input = `---
title: t
---
# Hello World

body para
`;
		const r = convertMarkdown(input);
		assert.equal(r.title, "Hello World");
		assert.ok(!r.body.includes("title: t"));
		assert.ok(!r.body.startsWith("# Hello"));
		assert.ok(r.body.includes("body para"));
	});

	it("converts wikilinks and keeps embeds for later", () => {
		const input = `See [[Note|别名]] and ![[pic.png]]`;
		const r = convertMarkdown(input, { stripFirstH1: false });
		assert.ok(r.body.includes("别名"));
		assert.ok(!r.body.includes("[[Note|别名]]"));
		assert.ok(r.body.includes("![[pic.png]]"));
		assert.equal(r.localImageRefs.length, 1);
		assert.equal(r.localImageRefs[0].path, "pic.png");
	});

	it("collects md local images but not remote", () => {
		const input = `![a](./x.png) ![b](https://file.cc98.org/a.webp)`;
		const refs = collectLocalImageRefs(input);
		assert.equal(refs.length, 1);
		assert.equal(refs[0].path, "./x.png");
	});

	it("converts callouts and highlights outside code", () => {
		const input = `> [!note] 提示\n> line\n\n==hi==`;
		const r = convertMarkdown(input, { stripFirstH1: false });
		assert.ok(r.body.includes("**note: 提示**"));
		assert.ok(r.body.includes("**hi**"));
		assert.ok(!r.body.includes("==hi=="));
	});

	it("strips comments outside code", () => {
		const input = `visible %%hidden%% end`;
		const r = convertMarkdown(input, { stripFirstH1: false });
		assert.ok(r.body.includes("visible"));
		assert.ok(r.body.includes("end"));
		assert.ok(!r.body.includes("hidden"));
	});

	it("does not transform inside fenced or inline code (COR-01)", () => {
		const input = `
Before ==boldme==

\`\`\`js
const x = "==not bold==";
%%keep%%
![[secret.png]]
\`\`\`

Inline \`==still==\` and \`![[a.png]]\`

After ![[real.png]]
`;
		const r = convertMarkdown(input, { stripFirstH1: false });
		assert.ok(r.body.includes("**boldme**"));
		assert.ok(r.body.includes('const x = "==not bold=="'));
		assert.ok(r.body.includes("%%keep%%"));
		assert.ok(r.body.includes("![[secret.png]]"));
		assert.ok(r.body.includes("`==still==`"));
		assert.ok(r.body.includes("`![[a.png]]`"));
		// only real.png outside code
		assert.equal(r.localImageRefs.length, 1);
		assert.equal(r.localImageRefs[0].path, "real.png");
	});

	it("protects indented fence and 4-space code from transforms (COR-02)", () => {
		const input = [
			"intro",
			"",
			"   ```",
			"==fence==",
			"![[secret.png]]",
			"   ```",
			"",
			"    ==indent==",
			"    ![[secret2.png]]",
			"",
			"![[ok.png]]",
			"",
		].join("\n");
		const r = convertMarkdown(input, { stripFirstH1: false });
		assert.ok(r.body.includes("==fence=="));
		assert.ok(r.body.includes("![[secret.png]]"));
		assert.ok(r.body.includes("==indent==") || r.body.includes("    ==indent=="));
		assert.ok(
			r.body.includes("![[secret2.png]]") ||
				r.body.includes("    ![[secret2.png]]")
		);
		assert.equal(r.localImageRefs.length, 1);
		assert.equal(r.localImageRefs[0].path, "ok.png");
	});

	it("still collects images under list continuation indent (R3-C02)", () => {
		const input = [
			"- item",
			"    ![[nested.png]]",
			"",
			"1. ordered",
			"    ![[ord.png]]",
			"",
		].join("\n");
		const r = convertMarkdown(input, { stripFirstH1: false });
		const paths = r.localImageRefs.map((x) => x.path).sort();
		assert.deepEqual(paths, ["nested.png", "ord.png"].sort());
	});

	it("does not collect images from indented code inside a list (R4-C01)", () => {
		const input = [
			"- item",
			"",
			"      ==code== ![[secret.png]]",
			"",
			"![[ok.png]]",
			"",
		].join("\n");
		const r = convertMarkdown(input, { stripFirstH1: false });
		assert.deepEqual(r.localImageRefs.map((x) => x.path), ["ok.png"]);
		assert.ok(r.body.includes("==code== ![[secret.png]]"));
	});

	it("does not collect pdf/mp4/zip as images (COR-02)", () => {
		const input = `![[a.pdf]] ![[b.mp4]] ![[c.zip]] ![[d.png]]`;
		const refs = collectLocalImageRefs(input);
		assert.equal(refs.length, 1);
		assert.equal(refs[0].path, "d.png");
	});

	it("parses md image path with parens and title (COR-04)", () => {
		const s = '![x](images/a(1).png "title")';
		const open = s.indexOf("(");
		const dest = parseMdImageDestination(s, open);
		assert.ok(dest);
		assert.equal(dest!.path, "images/a(1).png");
		const found = findMdImages(s);
		assert.equal(found.length, 1);
		assert.equal(found[0].path, "images/a(1).png");

		const refs = collectLocalImageRefs(s);
		assert.equal(refs.length, 1);
		assert.equal(refs[0].path, "images/a(1).png");
	});

	it("applyImageUrlMap rewrites wiki and md images (markdown)", () => {
		const md = `![[a.png]] and ![x](folder/b.jpg)`;
		const map = new Map([
			["a.png", "https://file.cc98.org/a.webp"],
			["folder/b.jpg", "https://file.cc98.org/b.webp"],
		]);
		const out = applyImageUrlMap(md, map, "markdown");
		assert.ok(out.includes("![a.png](https://file.cc98.org/a.webp)"));
		assert.ok(out.includes("![x](https://file.cc98.org/b.webp)"));
		assert.ok(!out.includes("![[a.png]]"));
	});

	it("applyImageUrlMap rewrites to UBB [img]", () => {
		const md = `![[a.png]]`;
		const map = new Map([["a.png", "https://file.cc98.org/a.webp"]]);
		const out = applyImageUrlMap(md, map, "ubb");
		assert.equal(out.trim(), "[img]https://file.cc98.org/a.webp[/img]");
	});

	it("applyImageUrlMap does not rewrite images inside code", () => {
		const md = "```\n![[a.png]]\n```\n![[a.png]]\n";
		const map = new Map([["a.png", "https://file.cc98.org/a.webp"]]);
		const out = applyImageUrlMap(md, map, "ubb");
		assert.ok(out.includes("```\n![[a.png]]\n```"));
		assert.ok(out.includes("[img]https://file.cc98.org/a.webp[/img]"));
	});

	it("materializeWikiEmbedsAsMd", () => {
		const out = materializeWikiEmbedsAsMd("![[x.png|图]]");
		assert.equal(out.trim(), "![图](x.png)");
	});

	it("mapOutsideCode leaves fences intact", () => {
		const md = "a\n```\nb==c==\n```\nd";
		const out = mapOutsideCode(md, (t) => t.replace(/==c==/g, "X"));
		assert.ok(out.includes("b==c=="));
		assert.ok(!out.includes("aX") || out.startsWith("a"));
	});
});

describe("shouldFailFastUpload", () => {
	it("fails fast on network and auth errors", () => {
		assert.equal(
			shouldFailFastUpload({ ok: false, networkIssue: true, error: "t" }),
			true
		);
		assert.equal(
			shouldFailFastUpload({
				ok: false,
				error: "上传鉴权失败 HTTP 401",
			}),
			true
		);
		assert.equal(
			shouldFailFastUpload({ ok: false, error: "找不到文件" }),
			false
		);
		assert.equal(
			shouldFailFastUpload({
				ok: false,
				status: 403,
				error: "上传被拒绝 HTTP 403: forbidden",
			}),
			false
		);
		assert.equal(
			shouldRetryUpload({ ok: false, status: 403 }),
			true
		);
		assert.equal(
			shouldRetryUpload({ ok: false, status: 401 }),
			false
		);
	});
});
