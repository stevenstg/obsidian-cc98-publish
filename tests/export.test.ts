import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatExportBody } from "../src/export";

describe("formatExportBody", () => {
	it("leaves Markdown output out of the UBB converter", () => {
		const body = "**bold**\n![](https://example.com/a.png)\n";
		assert.equal(formatExportBody(body, "markdown"), body);
		assert.ok(!formatExportBody(body, "markdown").includes("[b]"));
	});

	it("converts UBB output", () => {
		assert.equal(formatExportBody("**bold**", "ubb"), "[b]bold[/b]\n");
	});
});
