/**
 * Copy plain text to the system clipboard.
 * Prefer Clipboard API; fall back to textarea execCommand for older Electron.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// fall through
		}
	}

	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.left = "-9999px";
	ta.style.top = "0";
	document.body.appendChild(ta);
	ta.focus();
	ta.select();
	const ok = document.execCommand("copy");
	document.body.removeChild(ta);
	if (!ok) {
		throw new Error("无法写入剪贴板");
	}
}
