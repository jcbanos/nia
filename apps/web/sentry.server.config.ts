// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
const langfuseBaseUrl =
  process.env.LANGFUSE_BASE_URL?.trim() || "http://localhost:3001";

const openTelemetrySpanProcessors: SpanProcessor[] = [];
if (langfusePublicKey && langfuseSecretKey) {
  openTelemetrySpanProcessors.push(
    new LangfuseSpanProcessor({
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      baseUrl: langfuseBaseUrl,
      exportMode: "batched",
    }),
  );
}

Sentry.init({
  dsn: "https://a2a45e3557d108800849d6eba5281db1@o4511257100353536.ingest.de.sentry.io/4511257109659728",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  openTelemetrySpanProcessors,
});
