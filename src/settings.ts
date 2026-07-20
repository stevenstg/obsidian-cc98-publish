import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type Cc98PublishPlugin from "../main";
import type { ImageSyntax } from "./convert";
import {
	BOARD_LIST,
	findBoardsByQuery,
	getBoardNameById,
	normalizeBoardIdInput,
} from "./boards";

/** Full export dialect: UBB (full convert) or Markdown (keep MD + image URLs). */
export type ExportFormat = "ubb" | "markdown";

function stripBearerPrefix(raw: string): string {
	let t = (raw || "").trim();
	while (/^bearer\s+/i.test(t)) {
		t = t.replace(/^bearer\s+/i, "").trim();
	}
	return t;
}

export interface Cc98PublishSettings {
	accessToken: string;
	refreshToken: string;
	/** When false (default), refreshToken is not written to data.json. */
	persistRefreshToken: boolean;
	/** CC98 username for password grant (optional auto login). */
	username: string;
	/**
	 * Password is never written to data.json.
	 * Kept only in plugin session memory after user types it.
	 */
	password?: string;
	/** If true and tokens missing/expired, try password login before upload. */
	autoLoginBeforeUpload: boolean;
	apiBase: string;
	openIdBase: string;
	/**
	 * Export format (settings-only switch, no extra commands).
	 * - ubb: full MD→UBB
	 * - markdown: keep GFM
	 */
	exportFormat: ExportFormat;
	/** @deprecated use exportFormat; kept for migration */
	imageSyntax?: ImageSyntax;
	stripFrontmatter: boolean;
	stripFirstH1: boolean;
	stripTags: boolean;
	showTitleNotice: boolean;
	maxLength: number;
	defaultBoardId: string;
	openEditorAfterCopy: boolean;
}

export const DEFAULT_SETTINGS: Cc98PublishSettings = {
	accessToken: "",
	refreshToken: "",
	persistRefreshToken: false,
	username: "",
	password: "",
	autoLoginBeforeUpload: true,
	apiBase: "https://api.cc98.org",
	openIdBase: "https://openid.cc98.org",
	exportFormat: "ubb",
	stripFrontmatter: true,
	stripFirstH1: true,
	stripTags: false,
	showTitleNotice: true,
	maxLength: 8000,
	defaultBoardId: "",
	openEditorAfterCopy: false,
};

/** Resolve export format from settings (with legacy imageSyntax fallback). */
export function getExportFormat(s: Cc98PublishSettings): ExportFormat {
	if (s.exportFormat === "markdown" || s.exportFormat === "ubb") {
		return s.exportFormat;
	}
	if (s.imageSyntax === "markdown") return "markdown";
	return "ubb";
}

/** Public OAuth client used by the official CC98 web frontend (not a private secret). */
export const CC98_CLIENT = {
	client_id: "9a1fd200-8687-44b1-4c20-08d50a96e5cd",
	client_secret: "8b53f727-08e2-4509-8857-e34bf92b27f2",
};

export class Cc98SettingTab extends PluginSettingTab {
	plugin: Cc98PublishPlugin;
	private boardSearchQuery = "";

	constructor(app: App, plugin: Cc98PublishPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "CC98 Publish" });
		containerEl.createEl("p", {
			text: "转换笔记并上传本地图后复制到剪贴板。在设置中选择导出为 UBB 或 Markdown。",
		});

		// —— Login status card (weread-style) ——
		this.renderLoginCard(containerEl);

		new Setting(containerEl)
			.setName("导出格式")
			.setDesc(
				"UBB：完整 MD→UBB，粘贴 UBB 编辑器。Markdown：保留 GFM，粘贴 Markdown 编辑器。"
			)
			.addDropdown((dd) =>
				dd
					.addOption("ubb", "UBB（推荐）")
					.addOption("markdown", "Markdown")
					.setValue(
						this.plugin.settings.exportFormat === "markdown"
							? "markdown"
							: "ubb"
					)
					.onChange(async (value) => {
						this.plugin.settings.exportFormat =
							value === "markdown" ? "markdown" : "ubb";
						this.plugin.settings.imageSyntax =
							this.plugin.settings.exportFormat;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "账号登录" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "推荐用账号密码一键登录（与网页相同 OpenID）。需校园网/RVPN。密码只在内存，不落盘。",
		});

		new Setting(containerEl)
			.setName("用户名")
			.addText((text) => {
				text
					.setPlaceholder("CC98 用户名")
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.autocomplete = "username";
			});

		new Setting(containerEl)
			.setName("密码")
			.setDesc("仅当前会话有效，不会写入 data.json")
			.addText((text) => {
				text
					.setPlaceholder("密码")
					.setValue(this.plugin.getSessionPassword())
					.onChange((value) => {
						this.plugin.setSessionPassword(value);
					});
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "current-password";
			});

		new Setting(containerEl)
			.setName("上传前自动登录")
			.setDesc("无 token 时先 refresh，再尝试密码登录")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.autoLoginBeforeUpload)
					.onChange(async (v) => {
						this.plugin.settings.autoLoginBeforeUpload = v;
						await this.plugin.saveSettings();
					})
			);

		// Advanced tokens (collapsed visually under details)
		const adv = containerEl.createEl("details");
		adv.createEl("summary", { text: "高级：手动 Token / API 地址" });
		const advBody = adv.createDiv();

		new Setting(advBody)
			.setName("Access Token")
			.setDesc("一般无需手填；登录成功后自动写入")
			.addText((text) => {
				text
					.setPlaceholder("access_token")
					.setValue(this.plugin.settings.accessToken)
					.onChange(async (value) => {
						this.plugin.settings.accessToken = stripBearerPrefix(value);
						this.plugin.markLoginUnverified();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
			});

		new Setting(advBody)
			.setName("Refresh Token")
			.addText((text) => {
				text
					.setPlaceholder("refresh_token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value.trim();
						this.plugin.markLoginUnverified();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
			});

		new Setting(advBody)
			.setName("持久化 Refresh Token")
			.setDesc("OneDrive vault 建议关闭")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.persistRefreshToken)
					.onChange(async (v) => {
						this.plugin.settings.persistRefreshToken = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(advBody)
			.setName("API Base")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.apiBase)
					.onChange(async (value) => {
						this.plugin.settings.apiBase = value.replace(/\/$/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(advBody)
			.setName("OpenID Base")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.openIdBase)
					.onChange(async (value) => {
						this.plugin.settings.openIdBase = value.replace(/\/$/, "");
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "转换选项" });

		new Setting(containerEl)
			.setName("去掉 YAML frontmatter")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.stripFrontmatter).onChange(async (v) => {
					this.plugin.settings.stripFrontmatter = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("去掉正文第一个 # 一级标题")
			.setDesc("标题一般在网页发帖框单独填写")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.stripFirstH1).onChange(async (v) => {
					this.plugin.settings.stripFirstH1 = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("剥离 #标签")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.stripTags).onChange(async (v) => {
					this.plugin.settings.stripTags = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("复制后显示标题提示")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showTitleNotice).onChange(async (v) => {
					this.plugin.settings.showTitleNotice = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("长度警告阈值")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxLength))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!Number.isNaN(n) && n > 0) {
							this.plugin.settings.maxLength = n;
							await this.plugin.saveSettings();
						}
					})
			);

		containerEl.createEl("h3", { text: "默认版面" });
		this.renderBoardPicker(containerEl);

		new Setting(containerEl)
			.setName("复制后打开发帖页")
			.setDesc("使用上方选择的默认版面 ID")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openEditorAfterCopy).onChange(async (v) => {
					this.plugin.settings.openEditorAfterCopy = v;
					await this.plugin.saveSettings();
				})
			);
	}

	/** Weread-like status card: logged out / token pending verification / verified. */
	private renderLoginCard(containerEl: HTMLElement): void {
		const state = this.plugin.getLoginState();
		const hasToken = state !== "logged-out";
		const verified = state === "verified";
		const card = containerEl.createDiv({
			cls:
				"cc98-login-card" +
				(verified ? " is-logged-in" : hasToken ? " is-unverified" : ""),
		});

		const row = card.createDiv({ cls: "cc98-login-status-row" });
		const badge = row.createDiv({ cls: "cc98-login-badge" });
		badge.createSpan({ cls: "dot" });
		badge.createSpan({
			text: verified ? "登录完成" : hasToken ? "待验证" : "未登录",
		});

		const actions = row.createDiv({ cls: "cc98-login-actions" });

		if (hasToken) {
			const name =
				this.plugin.getLoginDisplayName() ||
				this.plugin.settings.username ||
				"（已保存 token）";
			const msg =
				this.plugin.getLastLoginMessage() ||
				(verified ? "token 已验证，可上传图片" : "已持有 token，首次上传时验证");
			card.createDiv({
				cls: "cc98-login-meta",
				text: `账号：${name}`,
			});
			card.createDiv({
				cls: "cc98-login-meta",
				text: msg,
			});

			const logoutBtn = actions.createEl("button", {
				text: "退出登录",
				cls: "mod-warning",
			});
			logoutBtn.onclick = async () => {
				await this.plugin.logout();
				this.display();
			};
		} else {
			card.createDiv({
				cls: "cc98-login-meta",
				text:
					this.plugin.getLastLoginMessage() ||
					"填写下方用户名密码后点击登录；成功后此处显示「登录完成」。",
			});
		}

		const loginBtn = actions.createEl("button", {
			text: hasToken ? "重新登录" : "登录",
			cls: "mod-cta",
		});
		loginBtn.onclick = async () => {
			loginBtn.setAttr("disabled", "true");
			loginBtn.setText("登录中…");
			try {
				await this.plugin.loginWithCredentials();
			} finally {
				this.display();
			}
		};
	}

	/** Dropdown of all boards + name search. */
	private renderBoardPicker(containerEl: HTMLElement): void {
		const currentId = this.plugin.settings.defaultBoardId;
		const currentName = getBoardNameById(currentId);
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: currentId
				? `当前：${currentName || "未知版面"}（id=${currentId}）。共收录 ${BOARD_LIST.length} 个版面（来自 Forum 前端 boardInfo，可能略滞后）。`
				: `尚未选择版面。共收录 ${BOARD_LIST.length} 个版面，可下拉选择或按名称搜索。`,
		});

		// Full dropdown (sorted by name) — value is id string
		const sorted = BOARD_LIST.slice().sort((a, b) =>
			a.name.localeCompare(b.name, "zh-CN")
		);
		new Setting(containerEl)
			.setName("从列表选择版面")
			.setDesc("下拉选择后写入默认版面 ID")
			.addDropdown((dd) => {
				dd.addOption("", "（未选择）");
				for (const b of sorted) {
					dd.addOption(String(b.id), `${b.name} (${b.id})`);
				}
				dd.setValue(currentId || "");
				dd.onChange(async (value) => {
					this.plugin.settings.defaultBoardId = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		// Search by name / id
		new Setting(containerEl)
			.setName("搜索版面名称")
			.setDesc("输入名称中的几个字，或直接输入数字 id")
			.addText((text) => {
				text
					.setPlaceholder("例如：学习、编程、信电、68")
					.setValue(this.boardSearchQuery)
					.onChange((value) => {
						this.boardSearchQuery = value;
						this.renderBoardHits(hitsHost);
					});
			});

		const hitsHost = containerEl.createDiv();
		this.renderBoardHits(hitsHost);

		// Manual id fallback
		new Setting(containerEl)
			.setName("版面 ID（手动）")
			.setDesc("仅接受纯数字；列表外的 id 也可保存")
			.addText((text) =>
				text
					.setPlaceholder("68")
					.setValue(this.plugin.settings.defaultBoardId)
					.onChange(async (value) => {
						const n = normalizeBoardIdInput(value);
						// allow empty clear; reject mixed like 68abc
						if (value.trim() === "") {
							this.plugin.settings.defaultBoardId = "";
							await this.plugin.saveSettings();
							return;
						}
						if (!n) {
							new Notice("CC98: 版面 ID 须为纯数字");
							return;
						}
						this.plugin.settings.defaultBoardId = n;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderBoardHits(host: HTMLElement): void {
		host.empty();
		const q = this.boardSearchQuery.trim();
		if (!q) return;

		const hits = findBoardsByQuery(q, 20);
		if (hits.length === 0) {
			host.createDiv({
				cls: "cc98-login-meta",
				text: "无匹配版面",
			});
			return;
		}

		const box = host.createDiv({ cls: "cc98-board-hits" });
		for (const b of hits) {
			const row = box.createDiv({ cls: "cc98-board-hit" });
			row.createSpan({ text: b.name });
			row.createSpan({ cls: "id", text: String(b.id) });
			row.onclick = async () => {
				this.plugin.settings.defaultBoardId = String(b.id);
				await this.plugin.saveSettings();
				new Notice(`CC98: 已选择「${b.name}」(${b.id})`);
				this.display();
			};
		}
	}
}
