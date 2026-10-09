// Liveness probe for the web container. It touches no dependency, so an outage elsewhere does
// not restart the renderer.
export function GET(): Response {
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
