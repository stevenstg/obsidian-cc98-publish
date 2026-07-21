import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCopyResultNotice } from "../src/copy-notice";

const base = {
	bodyLength: 120,
	format: "ubb" as const,
	localCount: 0,
	uploadAttempted: false,
	uploaded: 0,
	failures: [] as string[],
	unresolvedLocalImages: false,
	maxLength: 8000,
	title: "示例标题",
	showTitle: true,
};

describe("formatCopyResultNotice", () => {
	it("combines a successful result, editor and title", () => {
		const message = formatCopyResultNotice(base);
		assert.match(message, /已复制 120 字 · 导出 UBB · 无本地图/);
		assert.match(message, /CC98「UBB」编辑器/);
		assert.match(message, /标题建议：示例标题/);
		assert.doesNotMatch(message, /图片问题|下一步/);
	});

	it("shows partial 403 details, local-path warning and recovery steps", () => {
		const message = formatCopyResultNotice({
			...base,
			format: "markdown",
			localCount: 4,
			uploadAttempted: true,
			uploaded: 1,
			failures: [
				"a.png: 上传被拒绝 HTTP 403",
				"b.png: 上传被拒绝 HTTP 403",
				"c.png: 上传被拒绝 HTTP 403",
			],
			unresolvedLocalImages: true,
		});
		assert.match(message, /导出 Markdown · 上传 1\/4 · 问题 3/);
		assert.match(message, /a\.png: 上传被拒绝 HTTP 403/);
		assert.match(message, /本地图片路径，请勿直接发帖/);
		assert.match(message, /重新登录/);
		assert.match(message, /测试 API 连通性/);
		assert.match(message, /RVPN.*DIRECT/);
	});

	it("maps 401, network and missing-file errors to actionable steps", () => {
		assert.match(
			formatCopyResultNotice({
				...base,
				preflightError: "上传鉴权失败 HTTP 401",
			}),
			/设置中重新登录/
		);
		assert.match(
			formatCopyResultNotice({
				...base,
				failures: ["刷新 token 时网络超时，无法连通"],
			}),
			/测试 API 连通性.*RVPN.*DIRECT/
		);
		assert.match(
			formatCopyResultNotice({
				...base,
				failures: ["找不到文件: media/a.png"],
			}),
			/检查笔记中的图片路径/
		);
	});

	it("keeps the long-body warning", () => {
		assert.match(
			formatCopyResultNotice({ ...base, bodyLength: 8001 }),
			/⚠ 超过 8000 字/
		);
	});
});
