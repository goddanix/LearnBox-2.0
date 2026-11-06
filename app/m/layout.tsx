import type { Metadata, Viewport } from "next";

/** The phone app's frame (Learnbox 2.0, Slice 10): a full-screen page, no desktop chrome (see components/mobile/shell-switch.tsx). */
export const metadata: Metadata = {
	title: "Learnbox 2.0",
	description: "Learnbox 2.0 on your phone",
	manifest: "/m/manifest.webmanifest",
	icons: { apple: "/m/apple-touch-icon.png", icon: "/m/icon-192.png" },
	appleWebApp: { capable: true, title: "Learnbox 2.0", statusBarStyle: "black-translucent" },
	// no phone-number / address auto-links inside cards
	formatDetection: { telephone: false, address: false, email: false },
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
