/**
 * Runs once when the Next server starts. Phone access (Learnbox 2.0, Slice 10): if the learner left it switched on,
 * bring the gateway up with the app. Node runtime only — the gateway is a plain TCP listener.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { mobile } = await import("./src/server/mobile.ts");
	await mobile()
		.resume()
		.catch((e: unknown) => console.warn(`[mobile] gateway did not start: ${e instanceof Error ? e.message : String(e)}`));
}
