import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	BOARD_LIST,
	findBoardsByQuery,
	getBoardNameById,
	normalizeBoardIdInput,
} from "../src/boards";

describe("boards", () => {
	it("has unique ids and names", () => {
		const ids = new Set(BOARD_LIST.map((b) => b.id));
		const names = new Set(BOARD_LIST.map((b) => b.name));
		assert.equal(ids.size, BOARD_LIST.length);
		assert.equal(names.size, BOARD_LIST.length);
		assert.ok(BOARD_LIST.length >= 200);
	});

	it("matches pure numeric id exactly", () => {
		const hits = findBoardsByQuery("68");
		assert.equal(hits.length, 1);
		assert.equal(hits[0].name, "学习天地");
	});

	it("searches by name substring", () => {
		const hits = findBoardsByQuery("编程");
		assert.ok(hits.some((b) => b.id === 105));
	});

	it("getBoardNameById rejects non-pure digits", () => {
		assert.equal(getBoardNameById("68"), "学习天地");
		assert.equal(getBoardNameById("68abc"), "");
		assert.equal(normalizeBoardIdInput("68abc"), "");
		assert.equal(normalizeBoardIdInput("068"), "68");
		assert.equal(normalizeBoardIdInput("99999"), "99999");
	});
});
