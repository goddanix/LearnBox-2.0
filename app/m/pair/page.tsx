import { PairForm } from "@/components/mobile/pair-form";

export const dynamic = "force-dynamic";

/** The page the QR code opens: `?code=` carries the pairing code into the form. */
export default async function PairPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
	const { code } = await searchParams;
	return <PairForm initialCode={typeof code === "string" ? code.slice(0, 20) : ""} />;
}
