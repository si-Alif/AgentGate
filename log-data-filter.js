import fs from "node:fs";
import readline from "node:readline";

const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;
const REQUEST_ID_PATTERN = /reqId[:\s]+"([^"]+)"/;
const REQUEST_URL_PATTERN = /"url":\s*"([^"]+)"/;
const RESPONSE_TIME_PATTERN = /responseTime[:\s]+([0-9.]+)/;

function stripAnsi(line) {
  return line.replace(ANSI_ESCAPE_PATTERN, "");
}

function normalizeRoute(url) {
  return url.split("?")[0];
}

function pushMetric(metrics, route, time) {
  const existing = metrics.get(route);
  if (existing) {
    existing.push(time);
    return;
  }

  metrics.set(route, [time]);
}

function summarizeTimes(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((total, value) => total + value, 0);

  return {
    Count: count,
    "Avg (ms)": (sum / count).toFixed(2),
    "p50 (ms)": sorted[Math.floor(count * 0.5)].toFixed(2),
    "p95 (ms)": sorted[Math.floor(count * 0.95)].toFixed(2),
    "Max (ms)": sorted[sorted.length - 1].toFixed(2),
  };
}

async function analyzeLogs(filePath) {
  if (!filePath) {
    console.error("Please provide a log file path as an argument.");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Log file not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Analyzing log file: ${filePath}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  const metrics = new Map();
  const requestIds = new Map();
  let currentSection = null;
  let currentReqId = null;

  for await (const line of rl) {
    const cleanLine = stripAnsi(line);

    if (cleanLine.includes("incoming request")) {
      currentSection = "incoming";
      currentReqId = null;
      continue;
    }

    if (cleanLine.includes("request completed")) {
      currentSection = "completed";
      currentReqId = null;
      continue;
    }

    const reqIdMatch = cleanLine.match(REQUEST_ID_PATTERN);
    if (reqIdMatch) {
      currentReqId = reqIdMatch[1];
      if (!requestIds.has(currentReqId)) {
        requestIds.set(currentReqId, {});
      }
    }

    const urlMatch = cleanLine.match(REQUEST_URL_PATTERN);
    if (urlMatch && currentSection === "incoming" && currentReqId) {
      const requestState = requestIds.get(currentReqId);
      if (requestState) {
        requestState.url = normalizeRoute(urlMatch[1]);
      }
    }

    const resMatch = cleanLine.match(RESPONSE_TIME_PATTERN);
    if (resMatch && currentSection === "completed" && currentReqId) {
      const requestState = requestIds.get(currentReqId);
      const route = requestState?.url;
      if (route) {
        pushMetric(metrics, route, Number.parseFloat(resMatch[1]));
      }
    }
  }

  const rows = [...metrics.entries()].map(([route, times]) => ({
    Route: route,
    ...summarizeTimes(times),
  }));

  if (rows.length === 0) {
    console.error("No request/response metrics were found in the log file.");
    process.exit(1);
  }

  rows.sort((left, right) => left.Route.localeCompare(right.Route));
  console.table(rows);
}

analyzeLogs(process.argv[2] || "./concurrency-load.log");