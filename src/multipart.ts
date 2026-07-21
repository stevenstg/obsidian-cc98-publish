function sanitizeFilename(fileName: string): string {
	return fileName
		.replace(/["\r\n\\]/g, "_")
		.replace(/[\x00-\x1f\x7f]/g, "_");
}

/** Build the multipart body expected by CC98's POST /file endpoint. */
export function buildMultipart(
	fileName: string,
	data: ArrayBuffer,
	mimeType: string
): { body: ArrayBuffer; contentType: string } {
	const boundary = "----Cc98FormBoundary" + Date.now().toString(16);
	const safeName = sanitizeFilename(fileName);
	const encoder = new TextEncoder();
	const head = encoder.encode(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="contentType"\r\n\r\n` +
			`multipart/form-data\r\n` +
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="files"; filename="${safeName}"\r\n` +
			`Content-Type: ${mimeType}\r\n\r\n`
	);
	const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
	const fileBytes = new Uint8Array(data);
	const out = new Uint8Array(head.length + fileBytes.length + tail.length);
	out.set(head, 0);
	out.set(fileBytes, head.length);
	out.set(tail, head.length + fileBytes.length);
	return {
		body: out.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}
