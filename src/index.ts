// Entry point: start the review server and optionally run a scan on a schedule.
//
//   npm start            start the review server
//   npm run scan         run one discovery/draft cycle now
//
// SCAN_INTERVAL_HOURS (optional): if set, also run a scan every N hours while
// the server is up. Leave unset to drive scans from an external cron instead.

import { createServer } from "./server.js";
import { runScan } from "./scan.js";

const PORT = Number(process.env.PORT) || 8080;

const app = createServer();
app.listen(PORT, () => {
  console.log(`[reddit-founder-engine] review server listening on :${PORT}`);
  if (!process.env.APPROVAL_SECRET) {
    console.warn("[reddit-founder-engine] APPROVAL_SECRET is not set — the approve/post flow is disabled until it is.");
  }
});

const intervalHours = Number(process.env.SCAN_INTERVAL_HOURS);
if (Number.isFinite(intervalHours) && intervalHours > 0) {
  const runSafely = () => runScan().catch((err) => console.error("[scan] failed:", err));
  runSafely();
  setInterval(runSafely, intervalHours * 60 * 60 * 1000);
}
