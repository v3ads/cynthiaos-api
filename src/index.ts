import express, { Request, Response } from "express";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3003", 10);
const SERVICE_NAME = "cynthiaos-api";

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// ── API v1 prefix placeholder ─────────────────────────────────────────────────
app.get("/api/v1", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    version: "v1",
    status: "scaffold",
  });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not_found" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});

export default app;
