/**
 * LhMark — the app mark (Learnbox, 2026-10): an open box with a small
 * knowledge graph rising out of it, the same motif as the app icon
 * (build/icon-flat.svg) without the plate and gradients, so it stays crisp at
 * the sidebar's 24px. Inlined as JSX so it rides along with the components (no
 * network fetch, recolorable, crisp at any size). 700×700 viewBox, no padding:
 * sizing/padding is the consumer's job. The box takes `currentColor`, the
 * nodes are the brand amber.
 *
 * Replaces the upstream spiral mark in the sidebar band (also the
 * traffic-light gutter's resident in the merged desktop chrome). The export
 * keeps its upstream name so the one consumer (sidebar.tsx) is untouched.
 */
export function LhMark({ className = "" }: { className?: string }) {
	return (
		<svg viewBox="162 150 700 700" className={className} style={{ strokeLinejoin: "round", strokeLinecap: "round" }} aria-hidden="true">
			{/* the box: faces, then the open top */}
			<path d="M296 455 L512 580 L512 830 L296 705 Z" fill="currentColor" fillOpacity="0.28" />
			<path d="M512 580 L728 455 L728 705 L512 830 Z" fill="currentColor" fillOpacity="0.5" />
			<path d="M512 330 L728 455 L512 580 L296 455 Z" fill="#101013" fillOpacity="0.9" />
			{/* the graph rising out of the opening */}
			<g stroke="#ffb454" strokeWidth="22" fill="none">
				<path d="M512 448 L388 292 M512 448 L566 188 M512 448 L690 318 M388 292 L566 188 M566 188 L690 318" />
			</g>
			<g fill="#ffcf8a" stroke="#ffb454" strokeWidth="14">
				<circle cx="388" cy="292" r="38" />
				<circle cx="566" cy="188" r="46" />
				<circle cx="690" cy="318" r="38" />
				<circle cx="512" cy="448" r="32" />
			</g>
			{/* the box edges and the front rim */}
			<g fill="none" stroke="currentColor" strokeWidth="24">
				<path d="M296 455 L512 580 L728 455 M296 455 L296 705 L512 830 L728 705 L728 455 M512 580 L512 830" />
			</g>
			<path d="M296 455 L512 330 L728 455" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="24" />
		</svg>
	);
}
