import type { Cc98PublishSettings } from "./settings";

export function settingsForDisk(
	settings: Cc98PublishSettings,
	clearDiskTokens: boolean
): Cc98PublishSettings {
	const out = { ...settings, password: "" };
	if (clearDiskTokens) out.accessToken = "";
	if (clearDiskTokens || !out.persistRefreshToken) out.refreshToken = "";
	return out;
}
