import { priceResponse } from "./routes/price.js";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/price") return priceResponse(Number(url.searchParams.get("cents") ?? 0));
    return new Response("not found", { status: 404 });
  },
};
