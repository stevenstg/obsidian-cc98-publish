export interface CopyResultNoticeInput {
	bodyLength: number;
	format: "ubb" | "markdown";
	localCount: number;
	uploadAttempted: boolean;
	uploaded: number;
	failures: string[];
	unresolvedLocalImages: boolean;
	maxLength: number;
	title?: string;
	showTitle: boolean;
	preflightError?: string;
}

function nextStepFor(errors: string): string {
	if (/401/i.test(errors)) {
		return "在设置中重新登录后重试。";
	}
	if (/403|被拒绝/i.test(errors)) {
		return "先重新登录；仍失败则运行“CC98: 测试 API 连通性”，并检查校园网/RVPN及 *.cc98.org 的 DIRECT 规则。";
	}
	if (
		/超时|停止等待|网络|无法连通|failed to fetch|ECONN|ENOTFOUND|ETIMEDOUT|RVPN|proxy/i.test(
			errors
		)
	) {
		return "运行“CC98: 测试 API 连通性”，并检查校园网/RVPN及代理 DIRECT 规则。";
	}
	if (/找不到文件|读取失败/i.test(errors)) {
		return "检查笔记中的图片路径及对应文件是否存在。";
	}
	if (/鉴权|token|登录/i.test(errors)) {
		return "在设置中重新登录后重试。";
	}
	return errors ? "根据上方图片问题修正后重试。" : "";
}

export function formatCopyResultNotice(input: CopyResultNoticeInput): string {
	const summary = [
		`已复制 ${input.bodyLength} 字`,
		input.format === "ubb" ? "导出 UBB" : "导出 Markdown",
	];
	if (input.localCount === 0) {
		summary.push("无本地图");
	} else if (!input.uploadAttempted) {
		summary.push("未上传");
	} else {
		summary.push(`上传 ${input.uploaded}/${input.localCount}`);
	}
	if (input.failures.length) summary.push(`问题 ${input.failures.length}`);
	if (input.bodyLength > input.maxLength) {
		summary.push(`⚠ 超过 ${input.maxLength} 字`);
	}

	const lines = [
		`CC98: ${summary.join(" · ")}`,
		input.format === "ubb"
			? "请粘贴到 CC98「UBB」编辑器。"
			: "请粘贴到 CC98「Markdown」编辑器。",
	];
	if (input.showTitle && input.title) {
		lines.push(`标题建议：${input.title}`);
	}
	if (input.preflightError) {
		lines.push(`未上传原因：${input.preflightError}`);
	}
	if (input.failures.length) {
		lines.push(
			`图片问题：${input.failures.slice(0, 3).join("; ")}${
				input.failures.length > 3 ? "…" : ""
			}`
		);
	}
	if (input.unresolvedLocalImages) {
		lines.push("正文仍含本地图片路径，请勿直接发帖。");
	}

	const nextStep = nextStepFor(
		[input.preflightError || "", ...input.failures].join("\n")
	);
	if (nextStep) lines.push(`下一步：${nextStep}`);
	return lines.join("\n");
}
