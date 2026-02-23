import { normalizeEvent } from "@/lib/classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WIKIMEDIA_SSE =
  "https://stream.wikimedia.org/v2/stream/recentchange";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(WIKIMEDIA_SSE, {
          headers: { Accept: "text/event-stream" },
        });
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
        );
        controller.close();
        return;
      }

      if (!upstreamRes.body) {
        controller.close();
        return;
      }

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const raw = JSON.parse(jsonStr) as Record<string, unknown>;
              if (raw.type !== "edit") continue;

              const event = normalizeEvent(raw);
              if (!event) continue;

              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
              );
            } catch {
              // skip malformed lines
            }
          }
        }
      } catch {
        // client disconnected
      } finally {
        reader.cancel();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
