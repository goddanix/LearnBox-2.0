"use client";

import { usePathname } from "next/navigation";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";

/** The phone's pages live under /m. */
export const isPhonePath = (pathname: string | null): boolean => pathname === "/m" || (pathname?.startsWith("/m/") ?? false);

/**
 * The root layout's frame. On the Mac every page sits in the full app shell (sessions sidebar, activity dock, the
 * server-event stream, the update banner). The phone reaches only /m and a handful of study routes through the
 * gateway, so its pages get none of that: no sidebar, and no requests the gateway would refuse anyway.
 */
export function ShellSwitch({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	if (isPhonePath(pathname)) return <>{children}</>;
	return (
		<>
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</>
	);
}
