export default {
	async fetch(request, env, ctx) {
		const TARGET = "https://chat-history-keeper--nayanantiya.replit.app";

		try {
			const url = new URL(request.url);

			// Rewrite URL to target
			const targetUrl = TARGET + url.pathname + url.search;

			// Clone request with new URL
			const newRequest = new Request(targetUrl, {
				method: request.method,
				headers: request.headers,
				body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
				redirect: "follow",
			});

			const response = await fetch(newRequest);

			return response;
		} catch (err) {
			return new Response("Proxy error: " + err.message, { status: 500 });
		}
	},
};
