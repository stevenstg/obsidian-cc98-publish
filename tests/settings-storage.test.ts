import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Cc98PublishSettings } from "../src/settings";
import { settingsForDisk } from "../src/settings-storage";

const settings = (overrides: Partial<Cc98PublishSettings>) =>
	({ accessToken: "", refreshToken: "", persistRefreshToken: false, ...overrides }) as Cc98PublishSettings;

describe("settingsForDisk", () => {
	it("never writes password or non-persistent refresh token", () => {
		const out = settingsForDisk(
			settings({
				accessToken: "access",
				refreshToken: "refresh",
				password: "password",
				persistRefreshToken: false,
			}),
			false
		);
		assert.equal(out.password, "");
		assert.equal(out.accessToken, "access");
		assert.equal(out.refreshToken, "");
	});

	it("clears both tokens after successful secret write", () => {
		const out = settingsForDisk(
			settings({
				accessToken: "access",
				refreshToken: "refresh",
				persistRefreshToken: true,
			}),
			true
		);
		assert.equal(out.accessToken, "");
		assert.equal(out.refreshToken, "");
	});

	it("keeps opted-in tokens when secret write fails", () => {
		const out = settingsForDisk(
			settings({
				accessToken: "access",
				refreshToken: "refresh",
				persistRefreshToken: true,
			}),
			false
		);
		assert.equal(out.accessToken, "access");
		assert.equal(out.refreshToken, "refresh");
	});
});
