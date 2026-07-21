import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { convertMarkdown } from "./src/convert";
import { processImages } from "./src/images";
import { copyTextToClipboard } from "./src/clipboard";
import {
	Cc98PublishSettings,
	DEFAULT_SETTINGS,
	Cc98SettingTab,
	getExportFormat,
} from "./src/settings";
import {
	probeApi,
	NETWORK_HINT,
	normalizeAccessToken,
	loginWithPassword,
	refreshAccessToken,
	fetchMe,
} from "./src/cc98-api";
import { settingsForDisk } from "./src/settings-storage";
import { createSingleFlight, refreshThenLogin } from "./src/auth-flow";
import { formatExportBody, hasUnresolvedLocalImages } from "./src/export";

const SECRET_ACCESS = "cc98-publish-access";
const SECRET_REFRESH = "cc98-publish-refresh";

type AuthResult = {
	ok: boolean;
	error?: string;
	accessToken?: string;
	refreshToken?: string;
};

type SecretStorage = {
	getSecret: (key: string) => Promise<string | null>;
	setSecret: (key: string, value: string) => Promise<void>;
	deleteSecret?: (key: string) => Promise<void>;
};

export type LoginState = "logged-out" | "unverified" | "verified";

export default class Cc98PublishPlugin extends Plugin {
	settings: Cc98PublishSettings = { ...DEFAULT_SETTINGS };
	private running = false;
	private unloaded = false;
	/** In-memory refresh when persistRefreshToken is false */
	private sessionRefreshToken = "";
	/** Password never written to disk */
	private sessionPassword = "";
	/** Display name after successful login/me */
	private loginDisplayName = "";
	private lastLoginMessage = "";
	private loginVerified = false;
	private runAuth = createSingleFlight<AuthResult>();

	async onload() {
		this.unloaded = false;
		await this.loadSettings();

		console.info("[CC98 Publish] loaded", this.manifest.version);

		this.addRibbonIcon("clipboard-copy", "CC98: Copy note for paste", () => {
			void this.safeRun(() => this.copyCurrentNote(true));
		});

		this.addCommand({
			id: "cc98-copy-current-note",
			name: "CC98: Copy current note for paste",
			callback: () => {
				void this.safeRun(() => this.copyCurrentNote(true));
			},
		});

		this.addCommand({
			id: "cc98-copy-selection",
			name: "CC98: Copy selection for paste",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.safeRun(() => this.copySelection(editor, view, true));
			},
		});

		this.addCommand({
			id: "cc98-probe-network",
			name: "CC98: Test API connectivity",
			callback: () => {
				void this.safeRun(async () => {
					new Notice("CC98: 正在探测 api.cc98.org …");
					const r = await probeApi(this.settings.apiBase);
					if (this.unloaded) return;
					new Notice(
						r.ok ? `CC98: ${r.detail}` : `CC98: 网络不通 — ${r.detail}`,
						r.ok ? 8000 : 15000
					);
					if (!r.ok) {
						console.warn("[CC98 Publish]", NETWORK_HINT);
					}
				});
			},
		});

		this.addCommand({
			id: "cc98-login",
			name: "CC98: Login (fetch token)",
			callback: () => {
				void this.safeRun(async () => {
					await this.loginWithCredentials();
				});
			},
		});

		this.addSettingTab(new Cc98SettingTab(this.app, this));
	}

	getSessionPassword(): string {
		return this.sessionPassword;
	}

	setSessionPassword(p: string): void {
		this.sessionPassword = p;
	}

	getLoginDisplayName(): string {
		return this.loginDisplayName || this.settings.username || "";
	}

	getLastLoginMessage(): string {
		return this.lastLoginMessage;
	}

	markLoginUnverified(): void {
		this.loginVerified = false;
		this.lastLoginMessage = "token 已更新，等待验证";
	}

	getLoginState(): LoginState {
		const hasToken = !!(
			normalizeAccessToken(this.settings.accessToken) ||
			this.settings.refreshToken ||
			this.sessionRefreshToken
		);
		if (!hasToken) return "logged-out";
		return this.loginVerified ? "verified" : "unverified";
	}

	async logout(): Promise<void> {
		this.settings.accessToken = "";
		this.settings.refreshToken = "";
		this.sessionRefreshToken = "";
		this.sessionPassword = "";
		this.settings.password = "";
		this.loginDisplayName = "";
		this.lastLoginMessage = "已退出登录";
		this.loginVerified = false;

		const ss = this.getSecretStorage();
		let secretOk = true;
		if (ss) {
			for (const key of [SECRET_ACCESS, SECRET_REFRESH]) {
				try {
					await this.clearSecret(ss, key);
				} catch (e) {
					secretOk = false;
					console.warn(`[CC98 Publish] clear secret failed: ${key}`, e);
				}
			}
		}
		await this.saveSettings();
		if (secretOk) {
			new Notice("CC98: 已退出登录");
		} else {
			new Notice(
				"CC98: 已清除会话，但密钥存储删除可能失败，请检查系统钥匙串",
				10000
			);
		}
	}

	/**
	 * Login via OpenID password grant; fill access + refresh tokens.
	 * UI should show「登录完成」status card after success (weread-style).
	 */
	async loginWithCredentials(): Promise<AuthResult> {
		return this.runAuth(() => this.loginWithCredentialsNow());
	}

	private async loginWithCredentialsNow(): Promise<AuthResult> {
		const user = this.settings.username?.trim() || "";
		const pass = this.sessionPassword || this.settings.password || "";
		if (!user || !pass) {
			this.lastLoginMessage = "请先填写用户名和密码";
			new Notice("CC98: 请先填写用户名和密码", 8000);
			return { ok: false, error: "缺少用户名或密码" };
		}
		this.lastLoginMessage = "正在登录…";
		new Notice("CC98: 正在登录 openid.cc98.org …");
		const r = await loginWithPassword(
			this.settings.openIdBase,
			user,
			pass
		);
		if (this.unloaded) return { ok: false, error: "unloaded" };
		if (!r.ok || !r.accessToken) {
			this.lastLoginMessage = `登录失败：${r.error || "未知错误"}`;
			new Notice(`CC98: 登录失败 — ${r.error || "未知错误"}`, 12000);
			return { ok: false, error: r.error };
		}
		this.settings.accessToken = normalizeAccessToken(r.accessToken);
		if (r.refreshToken) {
			this.settings.refreshToken = r.refreshToken;
			this.sessionRefreshToken = r.refreshToken;
		}

		// Verify token + display name
		const me = await fetchMe(
			this.settings.apiBase,
			this.settings.accessToken
		);
		if (me.ok && me.name) {
			this.loginDisplayName = me.name;
			this.loginVerified = true;
		} else {
			this.loginDisplayName = user;
			this.loginVerified = false;
		}

		const mins = r.expiresIn
			? Math.round(r.expiresIn / 60)
			: undefined;
		this.lastLoginMessage = me.ok
			? mins
				? `登录完成 · token 约 ${mins} 分钟有效`
				: "登录完成"
			: `已获取 token，尚未验证：${me.error || "无法读取账号信息"}`;
		await this.saveSettings();
		new Notice(`CC98: ${this.lastLoginMessage}`, 8000);
		return {
			ok: true,
			accessToken: this.settings.accessToken,
			refreshToken: this.settings.refreshToken,
		};
	}

	/**
	 * Ensure we have an access token: existing → refresh → password login.
	 */
	async ensureAuthTokens(): Promise<AuthResult> {
		return this.runAuth(() => this.ensureAuthTokensNow());
	}

	private async ensureAuthTokensNow(forceRefresh = false): Promise<AuthResult> {
		const s = this.effectiveSettings();
		if (!forceRefresh && normalizeAccessToken(s.accessToken)) {
			return { ok: true, accessToken: normalizeAccessToken(s.accessToken) };
		}

		const refresh = s.refreshToken || this.sessionRefreshToken;
		const pass = this.sessionPassword || s.password || "";
		const canLogin = !!(
			s.autoLoginBeforeUpload &&
			s.username?.trim() &&
			pass
		);
		const result = await refreshThenLogin<AuthResult>(
			refresh
				? async () => {
					new Notice("CC98: 正在刷新 token …");
					const r = await refreshAccessToken(s.openIdBase, refresh);
					if (!r.ok || !r.accessToken) {
						console.warn("[CC98 Publish] refresh failed", r.error);
						return { ok: false, error: r.error || "刷新 token 失败" };
					}
					this.settings.accessToken = normalizeAccessToken(r.accessToken);
					if (r.refreshToken) {
						this.settings.refreshToken = r.refreshToken;
						this.sessionRefreshToken = r.refreshToken;
					}
					await this.saveSettings();
					this.loginVerified = false;
					this.lastLoginMessage = "token 已刷新，等待上传验证";
					return {
						ok: true,
						accessToken: this.settings.accessToken,
						refreshToken: this.settings.refreshToken,
					};
				}
				: null,
			canLogin ? () => this.loginWithCredentialsNow() : null
		);
		if (result?.ok) return result;

		if (!s.autoLoginBeforeUpload) {
			return {
				ok: false,
				error: `${result?.error ? `${result.error}；` : ""}未开启上传前自动登录`,
			};
		}

		if (!s.username?.trim() || !pass) {
			return {
				ok: false,
				error: `${result?.error ? `${result.error}；` : "无 token："}请在设置中登录，或填写用户名密码后重试`,
			};
		}

		return result || { ok: false, error: "鉴权失败" };
	}

	private reauthAfter401(): Promise<AuthResult> {
		return this.runAuth(() => this.ensureAuthTokensNow(true));
	}

	onunload() {
		this.unloaded = true;
		console.info("[CC98 Publish] unloaded");
	}

	private getSecretStorage(): SecretStorage | null {
		const ss = (this.app as unknown as { secretStorage?: unknown }).secretStorage;
		if (
			ss &&
			typeof (ss as { getSecret?: unknown }).getSecret === "function" &&
			typeof (ss as { setSecret?: unknown }).setSecret === "function"
		) {
			return ss as SecretStorage;
		}
		return null;
	}

	private async clearSecret(ss: SecretStorage, key: string): Promise<void> {
		if (ss.deleteSecret) await ss.deleteSecret(key);
		else await ss.setSecret(key, "");
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<Cc98PublishSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
		this.loginVerified = false;

		// Never keep password from disk
		this.settings.password = "";
		this.sessionPassword = "";

		// Migrate legacy imageSyntax → exportFormat
		if (!data?.exportFormat && data?.imageSyntax) {
			this.settings.exportFormat =
				data.imageSyntax === "markdown" ? "markdown" : "ubb";
		}
		if (!this.settings.exportFormat) {
			this.settings.exportFormat = "ubb";
		}

		// R3-S02: always strip password from disk ASAP
		const hadDiskPassword = !!(data && data.password);
		const diskAccess = (data?.accessToken || "").trim();
		const diskRefresh = (data?.refreshToken || "").trim();

		const ss = this.getSecretStorage();
		if (ss) {
			try {
				const a = await ss.getSecret(SECRET_ACCESS);
				const r = await ss.getSecret(SECRET_REFRESH);
				if (a) this.settings.accessToken = a;
				if (r) {
					this.settings.refreshToken = r;
					this.sessionRefreshToken = r;
				}

				// migrate disk tokens → secret only when secret empty
				let migrateOk = true;
				try {
					if (!a && diskAccess) {
						const tok = normalizeAccessToken(diskAccess);
						await ss.setSecret(SECRET_ACCESS, tok);
						this.settings.accessToken = tok;
					}
					if (!this.settings.persistRefreshToken) {
						// do not migrate refresh into secret when user disabled persist
						if (r) await this.clearSecret(ss, SECRET_REFRESH);
						if (diskRefresh) {
							this.sessionRefreshToken = diskRefresh;
							this.settings.refreshToken = diskRefresh;
						}
					} else if (!r && diskRefresh) {
						await ss.setSecret(SECRET_REFRESH, diskRefresh);
						this.settings.refreshToken = diskRefresh;
						this.sessionRefreshToken = diskRefresh;
					}
				} catch (e) {
					migrateOk = false;
					console.warn("[CC98 Publish] secret migrate write failed", e);
				}

				// clear disk secrets only after successful migrate/write path
				if (
					migrateOk &&
					(diskAccess || diskRefresh || hadDiskPassword)
				) {
					await this.persistSettingsDisk(this.settings, {
						clearDiskTokens: true,
					});
				} else if (hadDiskPassword) {
					await this.persistSettingsDisk(this.settings, {
						clearDiskTokens: false,
					});
				}
			} catch (e) {
				console.warn("[CC98 Publish] secretStorage read failed", e);
				if (hadDiskPassword) {
					await this.persistSettingsDisk(this.settings, {
						clearDiskTokens: false,
					});
				}
			}
		} else {
			if (hadDiskPassword || (!this.settings.persistRefreshToken && diskRefresh)) {
				// keep tokens on disk if no secretStorage; strip password & maybe refresh
				if (!this.settings.persistRefreshToken && diskRefresh) {
					this.sessionRefreshToken = diskRefresh;
					this.settings.refreshToken = diskRefresh;
				}
				await this.persistSettingsDisk(this.settings, {
					clearDiskTokens: false,
				});
			}
		}

		if (!this.settings.persistRefreshToken) {
			this.sessionRefreshToken =
				this.sessionRefreshToken || this.settings.refreshToken || "";
			if (!this.settings.refreshToken && this.sessionRefreshToken) {
				this.settings.refreshToken = this.sessionRefreshToken;
			}
		}
	}

	/**
	 * Write settings to disk.
	 * @param clearDiskTokens when true, blank access/refresh on disk (only after secret write OK)
	 */
	private async persistSettingsDisk(
		s: Cc98PublishSettings,
		opts?: { clearDiskTokens?: boolean }
	) {
		await this.saveData(settingsForDisk(s, !!opts?.clearDiskTokens));
	}

	async saveSettings() {
		if (this.unloaded) return;

		this.settings.accessToken = normalizeAccessToken(
			this.settings.accessToken
		);
		this.settings.refreshToken = (this.settings.refreshToken || "").trim();
		this.sessionRefreshToken = this.settings.refreshToken;
		// never persist password field
		this.settings.password = "";

		const ss = this.getSecretStorage();
		if (ss) {
			let secretWriteOk = true;
			try {
				if (this.settings.accessToken) {
					await ss.setSecret(SECRET_ACCESS, this.settings.accessToken);
				}
				if (this.settings.persistRefreshToken && this.settings.refreshToken) {
					await ss.setSecret(SECRET_REFRESH, this.settings.refreshToken);
				} else {
					await this.clearSecret(ss, SECRET_REFRESH);
				}
			} catch (e) {
				secretWriteOk = false;
				console.warn("[CC98 Publish] secretStorage write failed", e);
				new Notice(
					"CC98: 密钥存储写入失败，已保留 data.json 中的 token（若有）",
					10000
				);
			}
			// R3-S01: only clear disk tokens when secret write succeeded
			await this.persistSettingsDisk(this.settings, {
				clearDiskTokens: secretWriteOk,
			});
			return;
		}

		await this.persistSettingsDisk(this.settings, {
			clearDiskTokens: false,
		});
	}

	private effectiveSettings(): Cc98PublishSettings {
		const s = { ...this.settings };
		if (!s.refreshToken && this.sessionRefreshToken) {
			s.refreshToken = this.sessionRefreshToken;
		}
		if (this.sessionPassword) {
			s.password = this.sessionPassword;
		}
		return s;
	}

	private async safeRun(fn: () => Promise<void>) {
		if (this.unloaded) return;
		if (this.running) {
			new Notice("CC98: 正在处理上一份笔记，请稍候…");
			return;
		}
		this.running = true;
		const start = Date.now();
		new Notice("CC98: 开始处理…");
		try {
			await fn();
			if (!this.unloaded) {
				console.info(`[CC98 Publish] done in ${Date.now() - start}ms`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[CC98 Publish] failed", e);
			if (!this.unloaded) {
				new Notice(`CC98: 出错 — ${msg}`, 15000);
			}
		} finally {
			this.running = false;
		}
	}

	private isMarkdownFile(file: TFile): boolean {
		const ext = (file.extension || "").toLowerCase();
		return ext === "md" || ext === "markdown";
	}

	private async copyCurrentNote(upload: boolean) {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("CC98: 没有打开的笔记（请先点开一篇 .md）");
			return;
		}
		if (!this.isMarkdownFile(file)) {
			new Notice("CC98: 当前文件不是 Markdown（.md），请打开笔记后再试");
			return;
		}
		new Notice(`CC98: 读取「${file.basename}」…`);
		const source = await this.app.vault.read(file);
		if (this.unloaded) return;
		await this.runPipeline(source, file.path, file.basename, upload);
	}

	private async copySelection(
		editor: Editor,
		view: MarkdownView,
		upload: boolean
	) {
		const selected = editor.getSelection();
		if (!selected) {
			new Notice("CC98: 没有选中文本");
			return;
		}
		const file = view.file;
		const sourcePath = file?.path ?? "";
		const basename = file?.basename ?? "selection";
		await this.runPipeline(selected, sourcePath, basename, upload);
	}

	private async runPipeline(
		source: string,
		sourcePath: string,
		basename: string,
		upload: boolean
	) {
		let settings = this.effectiveSettings();
		const converted = convertMarkdown(source, {
			stripFrontmatter: settings.stripFrontmatter,
			stripFirstH1: settings.stripFirstH1,
			stripTags: settings.stripTags,
		});

		const localCount = converted.localImageRefs.length;
		let doUpload = upload && localCount > 0;
		if (doUpload) {
			const auth = await this.ensureAuthTokens();
			settings = this.effectiveSettings();
			// R3-A01: ensureAuth 失败则不要假装还能上传
			if (!auth.ok && !normalizeAccessToken(settings.accessToken)) {
				new Notice(
					`CC98: ${auth.error || "鉴权失败"}。将只转换不上传。`,
					12000
				);
				doUpload = false;
			} else {
				new Notice(
					`CC98: 转换完成，开始上传 ${localCount} 张图（每张最多约 20s）…`
				);
			}
		}
		if (!doUpload) {
			new Notice(
				localCount === 0
					? "CC98: 转换完成（无本地图），写入剪贴板…"
					: "CC98: 转换完成，写入剪贴板（未上传）…"
			);
		}

		const img = await processImages(
			this.app,
			sourcePath,
			converted,
			settings,
			doUpload,
			() => this.reauthAfter401()
		);

		if (this.unloaded) return;

		if (img.newAccessToken) {
			this.settings.accessToken = img.newAccessToken;
		}
		if (img.newRefreshToken) {
			this.settings.refreshToken = img.newRefreshToken;
			this.sessionRefreshToken = img.newRefreshToken;
		}
		if (img.newAccessToken || img.newRefreshToken) {
			await this.saveSettings();
		}
		if (img.uploaded > 0) {
			this.loginVerified = true;
			this.lastLoginMessage = "登录完成 · 上传鉴权已验证";
		}

		if (this.unloaded) return;

		const format = getExportFormat(settings);
		// Full MD→UBB when export format is UBB (images already [img] or still MD img)
		let body = formatExportBody(img.body, format);
		const hasLocalImages = hasUnresolvedLocalImages(body);

		try {
			await copyTextToClipboard(body);
		} catch (e) {
			new Notice(
				`CC98: 复制失败 — ${e instanceof Error ? e.message : String(e)}。正文 ${body.length} 字已生成。`,
				15000
			);
			console.warn(
				"[CC98 Publish] clipboard failed",
				e instanceof Error ? e.name : "error",
				"bodyLength=",
				body.length
			);
			return;
		}

		if (this.unloaded) return;

		const title = converted.title || basename;
		const parts: string[] = [
			`已复制 ${body.length} 字`,
			format === "ubb" ? "导出 UBB" : "导出 Markdown",
		];
		if (localCount === 0) {
			parts.push("无本地图");
		} else if (!doUpload) {
			parts.push("未上传");
		} else {
			parts.push(`上传 ${img.uploaded}/${localCount}`);
		}
		if (img.failed.length) {
			parts.push(`失败 ${img.failed.length}`);
		}
		if (body.length > settings.maxLength) {
			parts.push(`⚠ 超过 ${settings.maxLength} 字`);
		}

		new Notice(`CC98: ${parts.join(" · ")}`, 10000);

		if (hasLocalImages) {
			new Notice(
				"CC98: 已复制，但正文仍有本地图片路径，请勿直接发帖。",
				12000
			);
		} else if (doUpload && localCount > 0 && img.uploaded === 0) {
			new Notice(
				"CC98: 本地图一张都没上传成功。请查看图片问题与控制台。",
				12000
			);
		} else {
			new Notice(
				format === "ubb"
					? "请粘贴到 CC98「UBB」编辑器"
					: "请粘贴到 CC98「Markdown」编辑器",
				8000
			);
		}

		if (settings.showTitleNotice && title) {
			new Notice(`CC98 标题建议: ${title}`, 8000);
		}

		if (img.failed.length) {
			console.warn("[CC98 Publish] image failures:", img.failed);
			new Notice(
				`CC98 图片问题: ${img.failed.slice(0, 3).join("; ")}${
					img.failed.length > 3 ? "…" : ""
				}`,
				12000
			);
		}

		if (
			!this.unloaded &&
			!hasLocalImages &&
			settings.openEditorAfterCopy &&
			settings.defaultBoardId
		) {
			window.open(
				`https://www.cc98.org/editor/postTopic/${settings.defaultBoardId}`
			);
		}
	}
}
