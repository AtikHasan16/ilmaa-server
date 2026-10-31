import dotenv from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { EdgeTTS } from "node-edge-tts";
import { createRequireSupabaseAuth } from "./middleware/requireSupabaseAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Robustly resolve .env from server dir, current working dir, or project root
const envCandidates = [
  path.resolve(__dirname, ".env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../project-ilmaa/.env"),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

const port = Number(process.env.PORT) || 5000;
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;
const configuredOrigins =
  process.env.CORS_ORIGINS ||
  process.env.FRONTEND_URL ||
  process.env.VITE_FRONTEND_URL;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be configured.");
}
if (process.env.NODE_ENV === "production" && !configuredOrigins) {
  throw new Error("CORS_ORIGINS must be configured in production.");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});
const requireSupabaseAuth = createRequireSupabaseAuth(supabase);
const allowedOrigins = new Set(
  (configuredOrigins || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const supportedVoices = new Set(["en-US-ChristopherNeural"]);
const audioCacheDir = path.join(os.tmpdir(), "ilmaa_audio_cache");

fs.mkdirSync(audioCacheDir, { recursive: true });

const app = express();
app.set("trust proxy", 1);

// Security Headers Middleware
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Request Timeout Protection (Phase 3.3 Reliability - 10s max)
app.use((_req, res, next) => {
  res.setTimeout(10000, () => {
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        error: "GATEWAY_TIMEOUT",
        message: "Server processing timed out after 10 seconds.",
      });
    }
  });
  next();
});

// Structured Server Logger & Request ID Middleware (Phase 3.1 Observability)
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const start = Date.now();

  res.on("finish", () => {
    // Suppress noisy healthy heartbeats
    if (req.url === "/health" && res.statusCode === 200) return;

    const logRecord = {
      timestamp: new Date().toISOString(),
      requestId: req.id,
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Date.now() - start,
      userId: req.authUser?.id || null,
      ip: req.ip,
    };
    console.log(JSON.stringify(logRecord));
  });

  next();
});

app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
  }),
);

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
app.use(generalLimiter);

const ttsIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      success: false,
      error: "RATE_LIMIT_EXCEEDED",
      message: "Too many speech requests. Please try again shortly.",
    }),
});

const ttsUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.authUser.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      success: false,
      error: "USER_RATE_LIMIT_EXCEEDED",
      message: "Speech request limit reached. Please try again shortly.",
    }),
});

app.use("/api/tts", ttsIpLimiter);
app.use(express.json({ limit: "4kb" }));

// Basic liveness check
app.get("/health", (_req, res) => {
  res.json({
    success: true,
    status: "healthy",
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// Deep readiness check verifying Supabase database connectivity without leaking data (Phase 3.1)
app.get("/ready", async (_req, res) => {
  try {
    const { error } = await supabase.from("vocabularies").select("id").limit(1);
    if (error) throw error;
    res.status(200).json({
      success: true,
      status: "ready",
      database: "connected",
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch (err) {
    console.error("[Readiness check failed]:", err.message);
    res.status(503).json({
      success: false,
      status: "unavailable",
      database: "unreachable",
    });
  }
});

// Server-side validation schema for TTS requests (Phase 3.2 Security Hardening)
function validateTtsInput(req, res, next) {
  const rawText =
    typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const voice = req.body?.voice || "en-US-ChristopherNeural";

  if (!rawText) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "Field 'text' is required and cannot be empty.",
    });
  }
  if (rawText.length > 500) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "Field 'text' exceeds maximum length of 500 characters.",
    });
  }
  if (typeof voice !== "string" || !supportedVoices.has(voice)) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: `Unsupported voice '${voice}'. Supported: ${Array.from(supportedVoices).join(", ")}.`,
    });
  }

  req.cleanTtsInput = { text: rawText, voice };
  next();
}

async function handleTts(req, res) {
  const { text: rawText, voice } = req.cleanTtsInput;

  const cacheKey = crypto
    .createHash("sha256")
    .update(`${voice}:${rawText.toLowerCase()}`)
    .digest("hex");
  const cachePath = path.join(audioCacheDir, `${cacheKey}.mp3`);

  const sendAudio = () => {
    res
      .status(200)
      .type("audio/mpeg")
      .set("Cache-Control", "no-store")
      .sendFile(cachePath);
  };

  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100) {
    return sendAudio();
  }

  try {
    const tts = new EdgeTTS({
      voice,
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      rate: "-5%",
      timeout: 4000,
    });

    await tts.ttsPromise(rawText, cachePath);
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100) {
      return sendAudio();
    }
  } catch (error) {
    console.warn("[EdgeTTS unavailable; using fallback]:", error.message);
  }

  fs.rmSync(cachePath, { force: true });

  const fallbackUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(rawText)}&tl=en&client=tw-ob`;
  const fallbackRequest = https.get(fallbackUrl, (upstreamResponse) => {
    if (upstreamResponse.statusCode !== 200) {
      upstreamResponse.resume();
      return res.status(502).json({
        success: false,
        message: "Speech generation is temporarily unavailable.",
      });
    }

    res.status(200).type("audio/mpeg").set("Cache-Control", "no-store");
    const cacheStream = fs.createWriteStream(cachePath);
    cacheStream.on("error", (error) => {
      console.warn("[TTS cache write failed]:", error.message);
    });
    upstreamResponse.pipe(cacheStream);
    upstreamResponse.pipe(res);

    upstreamResponse.on("error", (error) => {
      cacheStream.destroy();
      console.error("[TTS fallback stream failed]:", error.message);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: "Speech generation is temporarily unavailable.",
        });
      } else {
        res.destroy(error);
      }
    });
  });

  fallbackRequest.setTimeout(8000, () => {
    fallbackRequest.destroy(new Error("TTS fallback request timed out."));
  });
  fallbackRequest.on("error", (error) => {
    console.error("[TTS fallback request failed]:", error.message);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: "Speech generation is temporarily unavailable.",
      });
    } else {
      res.destroy(error);
    }
  });
}

app.post(
  "/api/tts",
  requireSupabaseAuth,
  ttsUserLimiter,
  validateTtsInput,
  (req, res, next) => {
    handleTts(req, res).catch(next);
  },
);

app.use((_req, res) =>
  res.status(404).json({ success: false, message: "Not found." }),
);

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Request body is too large.",
    });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      success: false,
      message: "Request body must be valid JSON.",
    });
  }

  console.error("[TTS request failed]:", error.message);
  return res.status(500).json({
    success: false,
    message: "Speech generation is temporarily unavailable.",
  });
});

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const server = app.listen(port, () => {
    console.log(`[Imlaa TTS] Listening on port ${port}`);
  });

  const shutdown = (signal) => {
    console.log(`[Imlaa TTS] Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      console.log("[Imlaa TTS] HTTP server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[Imlaa TTS] Forced shutdown after timeout.");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export default app;
