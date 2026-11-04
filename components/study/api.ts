/** fetch → JSON for the study endpoints; a non-2xx becomes an Error carrying the server's message. */
export async function studyApi<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `Request failed (${res.status})`);
	}
	return (await res.json()) as T;
}

export const postJson = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
