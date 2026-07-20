import { App, TFile } from "obsidian";
import {
	ConvertResult,
	LocalImageRef,
	ImageSyntax,
	applyImageUrlMap,
	convertRemoteMdImagesToUbb,
	materializeWikiEmbedsAsMd,
	normalizePathKey,
} from "./convert";
import {
	uploadFile,
	refreshAccessToken,
	loginWithPassword,
	normalizeAccessToken,
	UploadResult,
} from "./cc98-api";
import { shouldFailFastUpload } from "./upload-policy";
import { refreshThenLogin } from "./auth-flow";
import type { Cc98PublishSettings } from "./settings";
import { getExportFormat } from "./settings";

export interface ProcessImagesResult {
	body: string;
	uploaded: number;
	failed: string[];
	/** Updated access token if refreshed. */
	newAccessToken?: string;
	/** Updated refresh token if server rotated it. */
	newRefreshToken?: string;
}

export interface ImageReauthResult {
	ok: boolean;
	error?: string;
	accessToken?: string;
	refreshToken?: string;
}

/**
 * Resolve a wiki/md image path relative to the source note into a TFile.
 */
export function resolveVaultFile(
	app: App,
	sourcePath: string,
	imagePath: string
): TFile | null {
	const cleaned = imagePath.trim().replace(/^<|>$/g, "");
	const dest = app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath);
	if (dest instanceof TFile) return dest;

	const direct = app.vault.getAbstractFileByPath(normalizePathKey(cleaned));
	if (direct instanceof TFile) return direct;

	const sourceDir = sourcePath.includes("/")
		? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
		: "";
	const rel = normalizePathKey(
		sourceDir ? `${sourceDir}/${cleaned}` : cleaned
	);
	const relFile = app.vault.getAbstractFileByPath(rel);
	if (relFile instanceof TFile) return relFile;

	return null;
}

async function ensureAccessToken(
	settings: Cc98PublishSettings
): Promise<{
	token: string;
	newAccessToken?: string;
	newRefreshToken?: string;
	error?: string;
}> {
	const existing = normalizeAccessToken(settings.accessToken);
	if (existing) {
		return { token: existing };
	}
	const refresh = settings.refreshToken?.trim();
	if (refresh) {
		const r = await refreshAccessToken(settings.openIdBase, refresh);
		if (r.ok && r.accessToken) {
			const token = normalizeAccessToken(r.accessToken);
			return {
				token,
				newAccessToken: token,
				newRefreshToken: r.refreshToken,
			};
		}
		return { token: "", error: r.error || "刷新 token 失败" };
	}
	return {
		token: "",
		error: "未配置 Access Token 或 Refresh Token，无法上传图片",
	};
}

function isAuthFailure(result: UploadResult): boolean {
	return !!result.error && /鉴权|401|403/.test(result.error);
}

/**
 * Upload all local images referenced in convert result; rewrite body URLs.
 * No cross-command cache (COR-03).
 */
export async function processImages(
	app: App,
	sourcePath: string,
	converted: ConvertResult,
	settings: Cc98PublishSettings,
	upload: boolean,
	reauthenticate?: () => Promise<ImageReauthResult>
): Promise<ProcessImagesResult> {
	let body = converted.body;
	const failed: string[] = [];
	let uploaded = 0;
	let newAccessToken: string | undefined;
	let newRefreshToken: string | undefined;

	// Image tag dialect follows full export format
	const syntax: ImageSyntax =
		getExportFormat(settings) === "markdown" ? "markdown" : "ubb";
	const refs = converted.localImageRefs;

	if (!upload || refs.length === 0) {
		if (!upload) {
			body = materializeWikiEmbedsAsMd(body);
		}
		if (syntax === "ubb") {
			body = convertRemoteMdImagesToUbb(body);
		}
		return { body, uploaded: 0, failed };
	}

	const tokenState = await ensureAccessToken(settings);
	if (tokenState.error || !tokenState.token) {
		failed.push(tokenState.error || "无 token");
		body = materializeWikiEmbedsAsMd(body);
		if (syntax === "ubb") body = convertRemoteMdImagesToUbb(body);
		return {
			body,
			uploaded: 0,
			failed,
			newAccessToken: tokenState.newAccessToken,
			newRefreshToken: tokenState.newRefreshToken,
		};
	}
	let token = tokenState.token;
	if (tokenState.newAccessToken) newAccessToken = tokenState.newAccessToken;
	if (tokenState.newRefreshToken) newRefreshToken = tokenState.newRefreshToken;

	const urlByPath = new Map<string, string>();
	/** Per-pipeline only: same path once */
	const uploadedThisRun = new Map<string, string>();
	/** One-shot reauth: refresh then password (AUTH-01) */
	let reauthAttempted = false;

	for (let idx = 0; idx < refs.length; idx++) {
		const ref = refs[idx];
		const file = resolveVaultFile(app, sourcePath, ref.path);
		if (!file) {
			failed.push(`找不到文件: ${ref.path}`);
			continue;
		}

		if (uploadedThisRun.has(file.path)) {
			const url = uploadedThisRun.get(file.path)!;
			urlByPath.set(ref.path, url);
			urlByPath.set(normalizePathKey(ref.path), url);
			urlByPath.set(file.path, url);
			urlByPath.set(file.name, url);
			continue;
		}

		let data: ArrayBuffer;
		try {
			data = await app.vault.readBinary(file);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			failed.push(`${ref.path}: 读取失败 (${msg})`);
			continue;
		}

		let result: UploadResult = await uploadFile(
			settings.apiBase,
			token,
			file.name,
			data
		);

		// 401/403 once: refresh → password grant → retry this image only
		if (!result.ok && isAuthFailure(result) && !reauthAttempted) {
			reauthAttempted = true;
			let recovered = false;

			if (reauthenticate) {
				const r = await reauthenticate();
				if (r.ok && r.accessToken) {
					token = normalizeAccessToken(r.accessToken);
					newAccessToken = token;
					if (r.refreshToken) newRefreshToken = r.refreshToken;
					recovered = true;
				}
			} else {
				const refresh = settings.refreshToken?.trim();
				const canLogin = !!(
					settings.autoLoginBeforeUpload &&
					settings.username?.trim() &&
					settings.password
				);
				const r = await refreshThenLogin(
					refresh
						? () => refreshAccessToken(settings.openIdBase, refresh)
						: null,
					canLogin
						? () =>
								loginWithPassword(
									settings.openIdBase,
									settings.username.trim(),
									settings.password!
								)
						: null
				);
				if (r?.ok && r.accessToken) {
					token = normalizeAccessToken(r.accessToken);
					newAccessToken = token;
					if (r.refreshToken) newRefreshToken = r.refreshToken;
					recovered = true;
				}
			}

			if (recovered) {
				result = await uploadFile(
					settings.apiBase,
					token,
					file.name,
					data
				);
			} else {
				failed.push(
					`${ref.path}: ${result.error || "鉴权失败"}（refresh/登录均未恢复）`
				);
				const rest = refs.length - idx - 1;
				if (rest > 0) {
					failed.push(`…跳过剩余 ${rest} 张（鉴权失败）`);
				}
				break;
			}
		}

		if (!result.ok || !result.url) {
			failed.push(`${ref.path}: ${result.error || "上传失败"}`);
			if (shouldFailFastUpload(result) || isAuthFailure(result)) {
				const rest = refs.length - idx - 1;
				if (rest > 0) {
					failed.push(
						`…跳过剩余 ${rest} 张（${
							result.networkIssue ? "网络不可达" : "鉴权失败"
						}）`
					);
				}
				break;
			}
			continue;
		}

		uploadedThisRun.set(file.path, result.url);
		urlByPath.set(ref.path, result.url);
		urlByPath.set(normalizePathKey(ref.path), result.url);
		urlByPath.set(file.name, result.url);
		urlByPath.set(file.path, result.url);
		uploaded += 1;
	}

	body = applyImageUrlMap(body, urlByPath, syntax);
	body = materializeWikiEmbedsAsMd(body);
	if (syntax === "ubb") {
		body = convertRemoteMdImagesToUbb(body);
	}

	return {
		body,
		uploaded,
		failed,
		newAccessToken,
		newRefreshToken,
	};
}

export type { LocalImageRef };
