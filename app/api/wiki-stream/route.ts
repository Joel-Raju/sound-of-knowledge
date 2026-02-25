import { normalizeEvent } from "@/lib/classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WIKIMEDIA_SSE =
  "https://stream.wikimedia.org/v2/stream/recentchange";

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(WIKIMEDIA_SSE, {
          headers: { Accept: "text/event-stream" },
          signal: request.signal,
        });
      } catch (err) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
          );
          controller.close();
        } catch {
          // ignore if controller is already errored
        }
        return;
      }

      if (!upstreamRes.body) {
        try { controller.close(); } catch {}
        return;
      }

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastSentTime = 0;
      const MIN_INTERVAL_MS = 50; // Max 20 events/second

      try {
        while (true) {
          if (request.signal.aborted) break;
          
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

              // Throttle events to prevent overwhelming clients
              const now = Date.now();
              if (now - lastSentTime >= MIN_INTERVAL_MS) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                );
                lastSentTime = now;
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      } catch (err) {
        // upstream connection died or client disconnected
      } finally {
        try {
          await reader.cancel().catch(() => {});
        } catch {}
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      // Handle client disconnects gracefully
    }
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
