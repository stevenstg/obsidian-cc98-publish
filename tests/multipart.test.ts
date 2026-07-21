import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMultipart } from "../src/multipart";

describe("buildMultipart", () => {
	it("matches the fields used by CC98's web uploader", () => {
		const { body, contentType } = buildMultipart(
			"a.png",
			new Uint8Array([1, 2, 3]).buffer,
			"image/png"
		);
		const text = new TextDecoder().decode(body);

		assert.match(contentType, /^multipart\/form-data; boundary=/);
		assert.ok(text.includes('name="contentType"\r\n\r\nmultipart/form-data'));
		assert.ok(text.includes('name="files"; filename="a.png"'));
		assert.ok(text.indexOf('name="contentType"') < text.indexOf('name="files"'));
	});
});
