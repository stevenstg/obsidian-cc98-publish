export interface FailFastResult {
	ok: boolean;
	error?: string;
	status?: number;
	networkIssue?: boolean;
}

export function isUploadAuthFailure(result: FailFastResult): boolean {
	return !result.ok && !!result.error && /鉴权|401/.test(result.error);
}

/** Whether remaining uploads should be skipped after this failure. */
export function shouldFailFastUpload(result: FailFastResult): boolean {
	if (result.ok) return false;
	if (result.networkIssue) return true;
	return isUploadAuthFailure(result);
}

export function shouldRetryUpload(result: FailFastResult): boolean {
	return !result.ok && result.status === 403;
}
