const fs = require("fs")
const path = require("path")

const sourcePath = path.join(__dirname, "main.js")
const runtimePath = path.join(__dirname, "main.runtime.js")
const FIX_CUTOFF_ISO = "2026-08-08T00:49:00.000Z"

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText)
  if (first === -1) {
    throw new Error(`TeleHub runtime patch failed: ${label} was not found.`)
  }
  if (source.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error(`TeleHub runtime patch failed: ${label} matched more than once.`)
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length)
}

function applyRuntimePatch(source) {
  let patched = source

  patched = replaceOnce(
    patched,
    `const BACKEND_BUILD_ID =
  "telehub-telemetr-nonoverlapping-ranges-2026-07-29"
`,
    `const BACKEND_BUILD_ID =
  "telehub-guided-discovery-resume-depth-fix-2026-08-07"
`,
    "backend build id"
  )

  patched = replaceOnce(
    patched,
    `const GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS = Math.max(
  GRAPH_CRAWL_COOLDOWN_HOURS,
  Number(process.env.GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS || 720)
)
`,
    `const GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS = Math.max(
  GRAPH_CRAWL_COOLDOWN_HOURS,
  Number(process.env.GRAPH_EMPTY_CRAWL_COOLDOWN_HOURS || 720)
)
const GRAPH_HISTORY_DEPTH_FIX_CUTOFF = Date.parse("${FIX_CUTOFF_ISO}")
`,
    "crawl-history cutoff insertion"
  )

  patched = replaceOnce(
    patched,
    `function graphHistoryEligible(history, settings, nowMs = Date.now()) {
  if (!history?.last_crawled_at) return true

  const requestedDepth = Math.max(
    1,
    Math.min(Number(settings?.max_depth || 1), 5)
  )
`,
    `function graphHistoryEligible(history, settings, nowMs = Date.now()) {
  if (!history?.last_crawled_at) return true

  // Older rows stored the run-wide max depth for every graph node. That made
  // nodes reached at depth 2/3 look fully explored as future root seeds.
  // Let legacy rows through once; the next scan rewrites them with the
  // corrected remaining-depth value.
  const lastCrawledMs = new Date(history.last_crawled_at).getTime()
  if (
    Number.isFinite(GRAPH_HISTORY_DEPTH_FIX_CUTOFF) &&
    Number.isFinite(lastCrawledMs) &&
    lastCrawledMs < GRAPH_HISTORY_DEPTH_FIX_CUTOFF
  ) {
    return true
  }

  // Failed/interrupted scans must not get locked behind a 7/30-day cooldown.
  if (
    history.last_status &&
    !["completed", "success"].includes(
      String(history.last_status).trim().toLowerCase()
    )
  ) {
    return true
  }

  const requestedDepth = Math.max(
    1,
    Math.min(Number(settings?.max_depth || 1), 5)
  )
`,
    "graphHistoryEligible legacy/retry logic"
  )

  patched = replaceOnce(
    patched,
    `  const last = new Date(history.last_crawled_at).getTime()
  if (!Number.isFinite(last)) return true
`,
    `  const last = lastCrawledMs
  if (!Number.isFinite(last)) return true
`,
    "graphHistoryEligible timestamp reuse"
  )

  patched = replaceOnce(
    patched,
    `.select("crawl_count, max_requested_depth")`,
    `.select("crawl_count, max_requested_depth, last_crawled_at")`,
    "crawl-history previous-row select"
  )

  patched = replaceOnce(
    patched,
    `    max_requested_depth: Math.max(
      Number(previous?.max_requested_depth || 0),
      Math.max(1, Math.min(Number(requestedMaxDepth || 1), 5))
    ),
`,
    `    max_requested_depth: Math.max(
      Number.isFinite(new Date(previous?.last_crawled_at || "").getTime()) &&
      new Date(previous?.last_crawled_at || "").getTime() <
        GRAPH_HISTORY_DEPTH_FIX_CUTOFF
        ? 0
        : Number(previous?.max_requested_depth || 0),
      Math.max(1, Math.min(Number(requestedMaxDepth || 1), 5))
    ),
`,
    "crawl-history legacy depth reset"
  )

  patched = replaceOnce(
    patched,
    `          requestedMaxDepth: maxDepth,
          status: "completed",
`,
    `          // Record the depth still available FROM THIS NODE, not the
          // run-wide depth. A node reached later in the graph can therefore
          // become a root on the next cycle and continue exploration outward.
          requestedMaxDepth: Math.max(1, maxDepth - depth),
          status: "completed",
`,
    "completed remaining-depth history"
  )

  patched = replaceOnce(
    patched,
    `          requestedMaxDepth: maxDepth,
          status: "failed",
`,
    `          requestedMaxDepth: Math.max(1, maxDepth - depth),
          status: "failed",
`,
    "failed remaining-depth history"
  )

  return patched
}

const original = fs.readFileSync(sourcePath, "utf8")
const patched = applyRuntimePatch(original)
fs.writeFileSync(runtimePath, patched, "utf8")

console.log(
  `[TeleHub] crawl resume/depth runtime patch applied; legacy cutoff ${FIX_CUTOFF_ISO}`
)

if (process.env.TELEHUB_PATCH_ONLY !== "1") {
  require(runtimePath)
}
