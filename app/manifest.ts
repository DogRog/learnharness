import type { MetadataRoute } from "next";

/** iPad access: "Add to Home Screen" opens LearnHarness full screen. */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "An agent harness for learning.",
		start_url: "/",
		display: "standalone",
		background_color: "#161616",
		theme_color: "#161616",
		icons: [
			{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
		],
	};
}
