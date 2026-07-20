export interface FailFastResult {
	ok: boolean;
	error?: string;
	networkIssue?: boolean;
}

/** Whether remaining uploads should be skipped after this failure. */
export function shouldFailFastUpload(result: FailFastResult): boolean {
	if (result.ok) return false;
	if (result.networkIssue) return true;
	return !!result.error && /鉴权|401|403/.test(result.error);
}
