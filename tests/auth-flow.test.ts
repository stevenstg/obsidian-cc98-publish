import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSingleFlight, refreshThenLogin } from "../src/auth-flow";

describe("auth flow", () => {
	it("coalesces concurrent authentication", async () => {
		const runOnce = createSingleFlight<number>();
		let calls = 0;
		const task = async () => ++calls;
		const [a, b] = await Promise.all([runOnce(task), runOnce(task)]);
		assert.deepEqual([a, b, calls], [1, 1, 1]);
		assert.equal(await runOnce(task), 2);
	});

	it("tries refresh before password and retries neither", async () => {
		const order: string[] = [];
		const result = await refreshThenLogin(
			async () => {
				order.push("refresh");
				return { ok: false, error: "expired" };
			},
			async () => {
				order.push("password");
				return { ok: true, accessToken: "new" };
			}
		);
		assert.deepEqual(order, ["refresh", "password"]);
		assert.equal(result?.accessToken, "new");
	});

	it("skips password when refresh succeeds", async () => {
		let logins = 0;
		const result = await refreshThenLogin(
			async () => ({ ok: true, accessToken: "refreshed" }),
			async () => {
				logins++;
				return { ok: true, accessToken: "login" };
			}
		);
		assert.equal(result?.accessToken, "refreshed");
		assert.equal(logins, 0);
	});
});
