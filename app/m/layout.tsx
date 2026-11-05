import type { Metadata, Viewport } from "next";

/** The phone app's frame (Learnbox 2.0, Slice 10): a full-screen page, no desktop chrome (see components/mobile/shell-switch.tsx). */
export const metadata: Metadata = {
	title: "Learnbox",
	description: "Learnbox on your phone",
	appleWebApp: { capable: true, title: "Learnbox", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	themeColor: "#161616",
};

export default function PhoneLayout({ children }: { children: React.ReactNode }) {
	return <div className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground">{children}</div>;
}
