import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatExportBody, hasUnresolvedLocalImages } from "../src/export";

describe("formatExportBody", () => {
	it("leaves Markdown output out of the UBB converter", () => {
		const body = "**bold**\n![](https://example.com/a.png)\n";
		assert.equal(formatExportBody(body, "markdown"), body);
		assert.ok(!formatExportBody(body, "markdown").includes("[b]"));
	});

	it("converts UBB output", () => {
		assert.equal(formatExportBody("**bold**", "ubb"), "[b]bold[/b]\n");
	});

	it("detects unresolved local images in Markdown and UBB", () => {
		assert.equal(hasUnresolvedLocalImages("![](assets/a.png)"), true);
		assert.equal(hasUnresolvedLocalImages("[img]assets/a.png[/img]"), true);
		assert.equal(
			hasUnresolvedLocalImages("[img]https://file.cc98.org/a.png[/img]"),
			false
		);
	});
});
