import { requestUrl } from "obsidian";
import { CC98_CLIENT } from "./settings";
import { buildMultipart } from "./multipart";

export interface UploadResult {
	ok: boolean;
	url?: string;
	error?: string;
	status?: number;
	/** True when error looks like campus-network / proxy / timeout. */
	networkIssue?: boolean;
}

/**
 * Normalize tokens copied from browser localStorage / Network.
 */
export function normalizeAccessToken(raw: string): string {
	let t = (raw || "").trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	) {
		t = t.slice(1, -1).trim();
	}
	while (/^bearer\s+/i.test(t)) {
		t = t.replace(/^bearer\s+/i, "").trim();
	}
	try {
		if (t.includes("%")) {
			const decoded = decodeURIComponent(t);
			if (decoded && decoded !== t) t = decoded;
		}
	} catch {
		// keep original
	}
	return t.trim();
}

export interface TokenResult {
	ok: boolean;
	accessToken?: string;
	refreshToken?: string;
	error?: string;
	expiresIn?: number;
	networkIssue?: boolean;
}

export const NETWORK_HINT =
	"无法连通 CC98 API。请先连校园网或浙大 RVPN(aTrust)；若开了系统代理/Clash，给 *.cc98.org / api.cc98.org / openid.cc98.org / file.cc98.org 走直连(DIRECT)。浏览器能开论坛 ≠ Obsidian 上传走同一路由。";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			const err = new Error(
				`${label}已停止等待(${ms / 1000}s)，请求可能仍在后台。${NETWORK_HINT}`
			);
			(err as Error & { networkIssue?: boolean }).networkIssue = true;
			reject(err);
		}, ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			}
		);
	});
}

function isNetworkishMessage(msg: string): boolean {
	return /timeout|超时|停止等待|network|Failed to fetch|ECONN|ENOTFOUND|ETIMEDOUT|aborted|连通|RVPN|proxy/i.test(
		msg
	);
}

async function postToken(
	openIdBase: string,
	params: Record<string, string>,
	label: string
): Promise<TokenResult> {
	const url = `${openIdBase.replace(/\/$/, "")}/connect/token`;
	const body = new URLSearchParams({
		client_id: CC98_CLIENT.client_id,
		client_secret: CC98_CLIENT.client_secret,
		...params,
	});

	try {
		const res = await withTimeout(
			requestUrl({
				url,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
				throw: false,
			}),
			20000,
			label
		);
		let data: Record<string, unknown> = {};
		try {
			data = res.json;
		} catch {
			return {
				ok: false,
				error: `${label}失败 HTTP ${res.status}`,
				networkIssue: res.status === 0,
			};
		}
		if (res.status < 200 || res.status >= 300 || !data.access_token) {
			const errMsg =
				String(data.error_description || data.error || "") ||
				`${label}失败 HTTP ${res.status}`;
			// common OIDC errors
			const friendly =
				data.error === "invalid_grant"
					? `${errMsg}（用户名/密码错误，或 refresh 已失效）`
					: errMsg;
			return { ok: false, error: friendly };
		}
		return {
			ok: true,
			accessToken: String(data.access_token),
			refreshToken:
				typeof data.refresh_token === "string"
					? data.refresh_token
					: undefined,
			expiresIn:
				typeof data.expires_in === "number" ? data.expires_in : undefined,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			error: msg,
			networkIssue:
				(e as { networkIssue?: boolean }).networkIssue ||
				isNetworkishMessage(msg),
		};
	}
}

/**
 * Password grant — same flow as CC98 web / community scripts.
 * Requires campus network or RVPN.
 */
export async function loginWithPassword(
	openIdBase: string,
	username: string,
	password: string
): Promise<TokenResult> {
	const u = username.trim();
	const p = password;
	if (!u || !p) {
		return { ok: false, error: "请填写用户名和密码" };
	}
	return postToken(
		openIdBase,
		{
			grant_type: "password",
			username: u,
			password: p,
			scope: "cc98-api openid offline_access",
		},
		"登录"
	);
}

/**
 * Refresh access_token; returns new refresh_token if server rotates it.
 */
export async function refreshAccessToken(
	openIdBase: string,
	refreshToken: string
): Promise<TokenResult> {
	if (!refreshToken) {
		return { ok: false, error: "未配置 refresh token" };
	}
	return postToken(
		openIdBase,
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		},
		"刷新 token"
	);
}

export async function uploadFile(
	apiBase: string,
	accessToken: string,
	fileName: string,
	data: ArrayBuffer,
	mimeType?: string
): Promise<UploadResult> {
	const token = normalizeAccessToken(accessToken);
	if (!token) {
		return { ok: false, error: "未配置 access token" };
	}

	const url = `${apiBase.replace(/\/$/, "")}/file`;
	const mime = mimeType || guessMime(fileName);
	const { body, contentType } = buildMultipart(fileName, data, mime);

	try {
		const res = await withTimeout(
			requestUrl({
				url,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": contentType,
				},
				body,
				throw: false,
			}),
			20000,
			"上传"
		);

		if (res.status === 401) {
			return { ok: false, status: 401, error: "上传鉴权失败 HTTP 401" };
		}
		if (res.status === 403) {
			const text = (res.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
			return {
				ok: false,
				status: 403,
				error: `上传被拒绝 HTTP 403${text ? `: ${text}` : ""}`,
			};
		}
		if (res.status < 200 || res.status >= 300) {
			const text = (res.text || "").slice(0, 200);
			return {
				ok: false,
				status: res.status,
				error: `上传失败 HTTP ${res.status}${text ? `: ${text}` : ""}`,
				networkIssue: res.status === 0,
			};
		}

		let json: unknown;
		try {
			json = res.json;
		} catch {
			return {
				ok: false,
				error: `上传响应非 JSON: ${(res.text || "").slice(0, 200)}`,
			};
		}

		if (Array.isArray(json) && json.length > 0 && typeof json[0] === "string") {
			return { ok: true, url: json[0] };
		}
		if (
			json &&
			typeof json === "object" &&
			typeof (json as { url?: string }).url === "string"
		) {
			return { ok: true, url: (json as { url: string }).url };
		}
		return {
			ok: false,
			error: `上传响应无法解析: ${JSON.stringify(json).slice(0, 200)}`,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			error: msg,
			networkIssue:
				(e as { networkIssue?: boolean }).networkIssue ||
				isNetworkishMessage(msg),
		};
	}
}

/** GET /me — verify token and read display name. */
export async function fetchMe(
	apiBase: string,
	accessToken: string
): Promise<{ ok: boolean; name?: string; error?: string }> {
	const token = normalizeAccessToken(accessToken);
	if (!token) return { ok: false, error: "无 token" };
	try {
		const res = await withTimeout(
			requestUrl({
				url: `${apiBase.replace(/\/$/, "")}/me`,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			}),
			12000,
			"获取用户信息"
		);
		if (res.status === 401 || res.status === 403) {
			return { ok: false, error: `鉴权失败 HTTP ${res.status}` };
		}
		if (res.status < 200 || res.status >= 300) {
			return { ok: false, error: `HTTP ${res.status}` };
		}
		const data = res.json as { name?: string; userName?: string };
		const name = data?.name || data?.userName || "";
		return { ok: true, name: name || undefined };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** Lightweight GET to check whether API base is reachable. */
export async function probeApi(apiBase: string): Promise<{
	ok: boolean;
	detail: string;
}> {
	const base = apiBase.replace(/\/$/, "");
	const url = `${base}/me`;
	try {
		const res = await withTimeout(
			requestUrl({
				url,
				method: "GET",
				throw: false,
			}),
			8000,
			"探测 API"
		);

		if (res.status === 0) {
			return { ok: false, detail: NETWORK_HINT };
		}
		if (res.status === 200 || res.status === 401 || res.status === 403) {
			return {
				ok: true,
				detail: `网络可达 ${base}（HTTP ${res.status}）。${
					res.status === 401 || res.status === 403
						? "需有效 token 才能上传。"
						: "上传就绪（已带身份时）。"
				}`,
			};
		}
		if (res.status === 404) {
			return {
				ok: false,
				detail: `HTTP 404：API Base 可能写错（当前 ${base}）`,
			};
		}
		if (res.status >= 500) {
			return {
				ok: false,
				detail: `HTTP ${res.status}：API 暂不可用，稍后再试`,
			};
		}
		return {
			ok: false,
			detail: `意外 HTTP ${res.status}，请核对 API Base`,
		};
	} catch (e) {
		return {
			ok: false,
			detail: e instanceof Error ? e.message : String(e),
		};
	}
}

function guessMime(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".bmp")) return "image/bmp";
	return "application/octet-stream";
}
