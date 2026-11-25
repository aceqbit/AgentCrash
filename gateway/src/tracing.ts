import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Context,
  type Span,
  type Attributes,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type IdGenerator,
} from "@opentelemetry/sdk-trace-base";

const SENTINEL = "0000000000000001";
let forcedSpanId: string | undefined;

class Ids implements IdGenerator {
  generateTraceId(): string {
    return randomBytes(16).toString("hex");
  }
  generateSpanId(): string {
    const f = forcedSpanId;
    forcedSpanId = undefined;
    return f ?? randomBytes(8).toString("hex");
  }
}

/**
 * Appends one JSON line per finished span. Lines are buffered and written in one append every few ms;
 * `flush()` writes synchronously and is called before a crash hook kills the process, so the spans
 * leading up to a crash still reach the file.
 */
class JsonlExporter implements SpanExporter {
  private buf: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly file: string | undefined,
    private readonly consoleOut: boolean,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
    process.on("exit", () => this.flush());
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.file && this.buf.length > 0) {
      const chunk = this.buf.join("");
      this.buf = [];
      appendFileSync(this.file, chunk);
    }
  }
  export(spans: ReadableSpan[], done: (r: { code: number }) => void): void {
    for (const s of spans) {
      const line = JSON.stringify({
        name: s.name,
        trace_id: s.spanContext().traceId,
        span_id: s.spanContext().spanId,
        parent_span_id: s.parentSpanContext?.spanId === SENTINEL ? null : (s.parentSpanContext?.spanId ?? null),
        start_ms: s.startTime[0] * 1000 + s.startTime[1] / 1e6,
        duration_ms: s.duration[0] * 1000 + s.duration[1] / 1e6,
        status: s.status.code,
        attributes: s.attributes,
        events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })),
        pid: process.pid,
      });
      if (this.file) appendFileSync(this.file, line + "\n");
      if (this.consoleOut) console.log("[span] " + line);
    }
    done({ code: 0 });
  }
  shutdown(): Promise<void> {
    this.flush();
    return Promise.resolve();
  }
}

export interface Tracing {
  runSpan(runId: string): void;
  withSpan<T>(
    runId: string,
    name: string,
    attrs: Attributes,
    fn: (span: Span, ctx: Context) => Promise<T>,
    parent?: Context,
  ): Promise<T>;
  runContext(runId: string): Context;
  instant(runId: string, name: string, attrs: Attributes, parent?: Context): void;
  /** Write buffered spans to disk now (synchronously). */
  flush(): void;
}

/** trace id = run_id without dashes; the run span id is derived from run_id too. */
export function traceIdOf(runId: string): string {
  return runId.replace(/-/g, "").toLowerCase();
}
export function runSpanIdOf(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 16);
}

export function createTracing(opts: { file?: string; console?: boolean }): Tracing {
  const exporter = new JsonlExporter(opts.file, opts.console ?? false);
  const provider = new BasicTracerProvider({
    idGenerator: new Ids(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("agentcrash-gateway");

  const runContext = (runId: string): Context =>
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: traceIdOf(runId),
      spanId: runSpanIdOf(runId),
      traceFlags: 1,
      isRemote: true,
    });

  return {
    flush: () => exporter.flush(),
    runContext,
    instant(runId, name, attrs, parent) {
      tracer.startSpan(name, { attributes: { "run.id": runId, ...attrs } }, parent ?? runContext(runId)).end();
    },
    runSpan(runId) {
      forcedSpanId = runSpanIdOf(runId);
      // Root span with the derived trace id: parent is a fake remote span, replaced below.
      const span = tracer.startSpan(
        "run",
        { attributes: { "run.id": runId } },
        trace.setSpanContext(ROOT_CONTEXT, {
          traceId: traceIdOf(runId),
          spanId: SENTINEL,
          traceFlags: 1,
          isRemote: true,
        }),
      );
      span.end();
    },
    async withSpan(runId, name, attrs, fn, parent) {
      const parentCtx = parent ?? runContext(runId);
      const span = tracer.startSpan(name, { attributes: { "run.id": runId, ...attrs } }, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      try {
        return await context.with(ctx, () => fn(span, ctx));
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        throw e;
      } finally {
        span.end();
      }
    },
  };
}