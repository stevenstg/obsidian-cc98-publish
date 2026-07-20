export type AuthAttempt = { ok: boolean; accessToken?: string; error?: string };

export function createSingleFlight<T>() {
	let pending: Promise<T> | null = null;
	return (task: () => Promise<T>): Promise<T> => {
		if (pending) return pending;
		const run = task().finally(() => {
			if (pending === run) pending = null;
		});
		pending = run;
		return run;
	};
}

export async function refreshThenLogin<T extends AuthAttempt>(
	refresh: (() => Promise<T>) | null,
	login: (() => Promise<T>) | null
): Promise<T | null> {
	let result: T | null = null;
	if (refresh) {
		result = await refresh();
		if (result.ok && result.accessToken) return result;
	}
	return login ? login() : result;
}
