import "dotenv/config";
import { chromium, type Page } from "playwright";
import { stringify } from "csv-stringify/sync";
import OpenAI from "openai";
import { fetchTranscript, type TranscriptResponse } from "youtube-transcript";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type TranscriptRow = {
  index: number;
  timestamp: string;
  startSeconds: number;
  text: string;
  deepLink: string;
};

type OutlineMode = {
  kind: "generic" | "list-style";
  itemLabel?: string;
  itemCount?: number;
};

const DEFAULT_SAMPLE_URL = "https://www.youtube.com/watch?v=WBy0T3UMyDw";

function parseVideoId(urlText: string): string {
  const url = new URL(urlText);

  if (url.hostname.includes("youtu.be")) {
    const id = url.pathname.replace("/", "").trim();
    if (id.length > 0) {
      return id;
    }
  }

  const watchId = url.searchParams.get("v");
  if (watchId && watchId.trim().length > 0) {
    return watchId.trim();
  }

  throw new Error("Could not parse a YouTube video id from the provided URL.");
}

function timestampToSeconds(timestamp: string): number {
  const parts = timestamp
    .trim()
    .split(":")
    .map((part) => Number.parseInt(part, 10));

  if (parts.some((part) => Number.isNaN(part))) {
    return 0;
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return 0;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function secondsToTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function makeDeepLink(videoId: string, startSeconds: number): string {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, startSeconds)}s`;
}

function cleanVideoTitle(title: string): string {
  return normalizeText(title).replace(/\s*-\s*YouTube\s*$/i, "").trim();
}

async function extractVideoTitle(page: Page): Promise<string> {
  const domTitle = cleanVideoTitle(
    (await page.locator("h1 yt-formatted-string").first().textContent().catch(() => null)) ??
      "",
  );

  if (domTitle.length > 0) {
    return domTitle;
  }

  return cleanVideoTitle(await page.title());
}

function singularizeLabel(label: string): string {
  const lower = label.toLowerCase();

  if (lower === "tips") return "tip";
  if (lower === "steps") return "step";
  if (lower === "options") return "option";
  if (lower === "ways") return "way";
  if (lower === "rules") return "rule";
  if (lower === "hacks") return "hack";
  if (lower === "lessons") return "lesson";
  if (lower === "secrets") return "secret";

  return label.replace(/s$/i, "");
}

function capitalizeLabel(label: string): string {
  return label.length === 0 ? label : `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function buildOutlineHeader(videoTitle: string, videoUrl: string, mode: OutlineMode, rowCount: number): string {
  const metadata = [
    "---",
    `title: ${JSON.stringify(videoTitle)}`,
    `video_url: ${JSON.stringify(videoUrl)}`,
    `outline_mode: ${JSON.stringify(mode.kind)}`,
    `transcript_rows: ${rowCount}`,
    "---",
  ].join("\n");

  return `${metadata}\n\n# [${videoTitle}](${videoUrl})`;
}

function wrapOutlineDocument(
  body: string,
  videoTitle: string,
  videoUrl: string,
  mode: OutlineMode,
  rowCount: number,
): string {
  const header = buildOutlineHeader(videoTitle, videoUrl, mode, rowCount);
  return `${header}\n\n${body.trim()}`;
}

function buildReferenceId(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

function buildReferenceDefinitions(rows: TranscriptRow[], videoUrl: string): string {
  const definitions = [
    `[video-url]: ${videoUrl}`,
    ...rows.map((row, index) => {
      const refId = buildReferenceId("t", index + 1);
      return `[${refId}]: ${row.deepLink}`;
    }),
  ];

  return definitions.join("\n");
}

function formatOutlineSections(rows: TranscriptRow[], mode: OutlineMode): string {
  return rows
    .map((row, index) => {
      const itemNumber = index + 1;
      const label = mode.kind === "list-style"
        ? `${capitalizeLabel(mode.itemLabel ?? "Item")} ${itemNumber}`
        : `Topic ${itemNumber}`;
      const short = row.text.length > 110 ? `${row.text.slice(0, 107)}...` : row.text;
      const refId = buildReferenceId("t", itemNumber);

      return [
        `## ${label} — [${row.timestamp}][${refId}]`,
        `- ${short}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildTranscriptPreview(rows: TranscriptRow[], maxRows = 25): string {
  return normalizeText(rows.slice(0, maxRows).map((row) => row.text).join(" "));
}

function detectOutlineMode(videoTitle: string, rows: TranscriptRow[]): OutlineMode {
  const title = normalizeText(videoTitle);
  const intro = buildTranscriptPreview(rows);
  const explicitMatch = title.match(
    /\b(?<count>\d{1,3})\s*(?<label>tips?|steps?|options?|ways?|rules?|hacks?|lessons?|secrets?)\b/i,
  );

  if (explicitMatch?.groups) {
    const count = Number.parseInt(explicitMatch.groups.count ?? "", 10);
    const label = singularizeLabel(explicitMatch.groups.label ?? "tip");

    if (!Number.isNaN(count)) {
      return { kind: "list-style", itemCount: count, itemLabel: label };
    }
  }

  const introMatch = intro.match(
    /\b(?:top|(?:\d{1,3}))\s*(?<count>\d{1,3})?\s*(?<label>tips?|steps?|options?|ways?|rules?|hacks?|lessons?|secrets?)\b/i,
  );

  if (introMatch?.groups) {
    const countText = introMatch.groups.count ?? "";
    const count = Number.parseInt(countText, 10);
    const label = singularizeLabel(introMatch.groups.label ?? "tip");

    if (!Number.isNaN(count) && count > 0) {
      return { kind: "list-style", itemCount: count, itemLabel: label };
    }

    return { kind: "list-style", itemLabel: label };
  }

  const cuePattern = /\b(tip|step|option|way|rule|hack|lesson|secret)(?:\s+number)?\s+(?:#?\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
  const cueHits = rows.slice(0, 300).filter((row) => cuePattern.test(row.text)).length;

  if (cueHits >= 2) {
    const label = title.match(/\b(tips?|steps?|options?|ways?|rules?|hacks?|lessons?|secrets?)\b/i)?.[1];

    return {
      kind: "list-style",
      itemLabel: singularizeLabel(label ?? "tip"),
    };
  }

  return { kind: "generic" };
}

function normalizeOffsetToSeconds(offset: number, duration?: number): number {
  if (!Number.isFinite(offset) || offset < 0) {
    return 0;
  }

  // Some providers emit offsets/durations in milliseconds, others in seconds.
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 20) {
    return Math.floor(offset / 1000);
  }

  if (Number.isInteger(offset) && offset > 200 && offset < 10_000) {
    return Math.floor(offset / 1000);
  }

  if (offset >= 10_000) {
    return Math.floor(offset / 1000);
  }

  return Math.floor(offset);
}

async function tryExpandDescription(page: Page): Promise<boolean> {
  const selectors = [
    "tp-yt-paper-button#expand",
    "button[aria-label*='more' i]",
    "button:has-text('...more')",
    "button:has-text('more')",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) < 1) {
      continue;
    }

    try {
      await locator.click({ timeout: 1500 });
      return true;
    } catch {
      // Continue trying fallback selectors.
    }
  }

  return false;
}

async function tryOpenTranscript(page: Page): Promise<boolean> {
  const selectors = [
    "button:has-text('Show transcript')",
    "yt-formatted-string:has-text('Show transcript')",
    "button:has-text('Transcript')",
    "yt-formatted-string:has-text('Transcript')",
    "[aria-label*='transcript' i]",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) < 1) {
      continue;
    }

    try {
      await locator.click({ timeout: 2500 });
      return true;
    } catch {
      // Continue trying fallback selectors.
    }
  }

  return false;
}

async function extractTranscriptRows(page: Page, videoId: string): Promise<TranscriptRow[]> {
  const rawRows = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"));

    return items.map((item) => {
      const timestampNode = item.querySelector(
        "#segment-timestamp, .segment-timestamp, [class*='timestamp']",
      );
      const textNode = item.querySelector(
        "#segment-text, .segment-text, yt-formatted-string, [class*='segment-text']",
      );

      return {
        timestamp: (timestampNode?.textContent ?? "").trim(),
        text: (textNode?.textContent ?? "").trim(),
      };
    });
  });

  const rows: TranscriptRow[] = rawRows
    .map((raw, index) => {
      const timestamp = normalizeText(raw.timestamp);
      const text = normalizeText(raw.text);
      const startSeconds = timestampToSeconds(timestamp);

      return {
        index: index + 1,
        timestamp,
        startSeconds,
        text,
        deepLink: makeDeepLink(videoId, startSeconds),
      };
    })
    .filter((row) => row.timestamp.length > 0 && row.text.length > 0);

  return rows;
}

async function extractTranscriptRowsFromCaptionTrack(
  page: Page,
  videoId: string,
): Promise<TranscriptRow[]> {
  const rawRows = await page.evaluate(async () => {
    const playerResponse = (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse as {
      captions?: {
        playerCaptionsTracklistRenderer?: {
          captionTracks?: Array<{ baseUrl?: string; kind?: string }>;
        };
      };
    };

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (!Array.isArray(tracks) || tracks.length === 0) {
      return [] as Array<{ timestamp: string; startSeconds: number; text: string }>;
    }

    const preferredTrack = tracks.find((track) => track.kind !== "asr") ?? tracks[0];
    if (!preferredTrack?.baseUrl) {
      return [] as Array<{ timestamp: string; startSeconds: number; text: string }>;
    }

    const captionUrl = `${preferredTrack.baseUrl}&fmt=json3`;

    try {
      const response = await fetch(captionUrl);
      if (!response.ok) {
        return [] as Array<{ timestamp: string; startSeconds: number; text: string }>;
      }

      const payload = (await response.json()) as {
        events?: Array<{
          tStartMs?: number;
          segs?: Array<{ utf8?: string }>;
        }>;
      };

      return (payload.events ?? [])
        .map((event) => {
          const startSeconds = Math.floor((event.tStartMs ?? 0) / 1000);
          const text = (event.segs ?? [])
            .map((seg) => seg.utf8 ?? "")
            .join("")
            .replace(/\s+/g, " ")
            .trim();

          return {
            startSeconds,
            text,
            timestamp: "",
          };
        })
        .filter((item) => item.text.length > 0);
    } catch {
      return [] as Array<{ timestamp: string; startSeconds: number; text: string }>;
    }
  });

  return rawRows.map((row, index) => {
    const timestamp = secondsToTimestamp(row.startSeconds);

    return {
      index: index + 1,
      timestamp,
      startSeconds: row.startSeconds,
      text: normalizeText(row.text),
      deepLink: makeDeepLink(videoId, row.startSeconds),
    };
  });
}

async function extractTranscriptRowsWithLibrary(videoUrl: string, videoId: string): Promise<TranscriptRow[]> {
  const rowsFromLib = (await fetchTranscript(videoUrl)) as TranscriptResponse[];

  return rowsFromLib
    .map((row, index) => {
      const startSeconds = normalizeOffsetToSeconds(row.offset, row.duration);

      return {
        index: index + 1,
        timestamp: secondsToTimestamp(startSeconds),
        startSeconds,
        text: normalizeText(row.text),
        deepLink: makeDeepLink(videoId, startSeconds),
      };
    })
    .filter((row) => row.text.length > 0)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((row, index) => ({
      ...row,
      index: index + 1,
    }));
}

function buildFallbackOutline(
  rows: TranscriptRow[],
  videoTitle: string | undefined,
  mode: OutlineMode,
  videoUrl: string,
): string {
  const usable = rows.filter((row) => row.text.length > 0);
  if (usable.length === 0) {
    const titleText = videoTitle ?? "Untitled video";
    const body = [
      "## Transcript Unavailable",
      "- Timestamp: n/a",
      "- Topic: Transcript rows were not available for outlining.",
    ].join("\n");

    return wrapOutlineDocument(
      `${body}\n\n${buildReferenceDefinitions([], videoUrl)}`,
      titleText,
      videoUrl,
      mode,
      0,
    );
  }

  const sectionCount = mode.kind === "list-style"
    ? Math.min(mode.itemCount ?? 10, 10, usable.length)
    : Math.min(8, usable.length);
  const stride = Math.max(1, Math.floor(usable.length / sectionCount));
  const picked = usable.filter((_, idx) => idx % stride === 0).slice(0, sectionCount);

  const sections = formatOutlineSections(picked, mode);

  const titleText = videoTitle ?? "Untitled video";
  return wrapOutlineDocument(
    `${sections}\n\n${buildReferenceDefinitions(picked, videoUrl)}`,
    titleText,
    videoUrl,
    mode,
    usable.length,
  );
}

async function generateListStyleOutlineWithLlm(
  rows: TranscriptRow[],
  videoTitle: string,
  videoUrl: string,
  mode: OutlineMode,
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    return buildFallbackOutline(rows, videoTitle, mode, videoUrl);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const condensed = rows
    .slice(0, 1400)
    .map((row) => `${row.timestamp} | ${row.deepLink} | ${row.text}`)
    .join("\n");

  const expectedItemText = mode.itemCount && mode.itemLabel
    ? `${mode.itemCount} ${mode.itemLabel}s`
    : mode.itemLabel
      ? `${mode.itemLabel}s`
      : "ordered sections";

  const prompt = [
    `Create a high-level markdown outline for the YouTube video titled: ${videoTitle}.`,
    `The title and transcript indicate this is a list-style video with ${expectedItemText}.`,
    "Rules:",
    "- Output markdown only.",
    "- Start with a single H1 using the video title.",
    "- Create one H2 per major item/step/tip in the video.",
    "- If the transcript clearly labels an item number, preserve it in the heading (for example: Tip #5).",
    "- Put the timestamp and direct YouTube deep link on the H2 line.",
    "- Use only timestamps and topics supported by the transcript rows.",
    "- Keep each item concise, with at most one short bullet summary.",
    "- Prefer the highest-level topic for each item rather than every minor sub-point.",
    "",
    "Transcript rows:",
    condensed,
  ].join("\n");

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const text = (response.output_text ?? "").trim();
  if (text.length === 0) {
    return buildFallbackOutline(rows, videoTitle, mode, videoUrl);
  }

  return wrapOutlineDocument(
    `${text.replace(/^#(?!#)/gm, "##")}\n\n${buildReferenceDefinitions(rows, videoUrl)}`,
    videoTitle,
    videoUrl,
    mode,
    rows.length,
  );
}

async function generateOutlineWithLlm(
  rows: TranscriptRow[],
  videoTitle: string,
  videoUrl: string,
): Promise<string> {
  const mode = detectOutlineMode(videoTitle, rows);

  if (mode.kind === "list-style") {
    return generateListStyleOutlineWithLlm(rows, videoTitle, videoUrl, mode);
  }

  if (!process.env.OPENAI_API_KEY) {
    return buildFallbackOutline(rows, videoTitle, mode, videoUrl);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const condensed = rows
    .slice(0, 1200)
    .map((row) => `${row.timestamp} | ${row.deepLink} | ${row.text}`)
    .join("\n");

  const prompt = [
    `Generate a markdown outline from the transcript lines below for the video titled: ${videoTitle}.`,
    "Rules:",
    "- Use headings that start at H2 only (##).",
    "- Each section must include topic label, one timestamp, and one URL.",
    "- Use only timestamps and URLs present in the transcript lines.",
    "- Keep each section concise.",
    "- Output markdown only.",
    "",
    "Transcript lines:",
    condensed,
  ].join("\n");

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const text = (response.output_text ?? "").trim();
  if (text.length === 0) {
    return buildFallbackOutline(rows, videoTitle, mode, videoUrl);
  }

  return wrapOutlineDocument(
    `${text.replace(/^#(?!#)/gm, "##")}\n\n${buildReferenceDefinitions(rows, videoUrl)}`,
    videoTitle,
    videoUrl,
    mode,
    rows.length,
  );
}

async function main(): Promise<void> {
  const videoUrl = process.argv[2] ?? DEFAULT_SAMPLE_URL;
  const videoId = parseVideoId(videoUrl);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(process.cwd(), "outputs", videoId, runId);

  await mkdir(runDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const summary = {
    videoUrl,
    videoId,
    videoTitle: "",
    runId,
    runDir,
    descriptionExpanded: false,
    transcriptOpened: false,
    transcriptCount: 0,
    extractionMode: "transcript-panel",
    selectedSource: "DOM",
    outlineMode: "generic",
    extractionStages: {
      domTranscriptPanel: {
        attempted: false,
        success: false,
        rowCount: 0,
      },
      captionTrackFallback: {
        attempted: false,
        success: false,
        rowCount: 0,
      },
      youtubeTranscriptLibraryFallback: {
        attempted: false,
        success: false,
        rowCount: 0,
      },
    },
  };

  try {
    await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

    const videoTitle = await extractVideoTitle(page);
    summary.videoTitle = videoTitle;

    summary.descriptionExpanded = await tryExpandDescription(page);
    summary.transcriptOpened = await tryOpenTranscript(page);

    try {
      await page.waitForSelector("ytd-transcript-segment-renderer", { timeout: 12_000 });
    } catch {
      // Continue and try to extract whatever is available.
    }

    summary.extractionStages.domTranscriptPanel.attempted = true;
    console.log("[extract] Trying DOM transcript panel...");
    let rows = await extractTranscriptRows(page, videoId);
    summary.extractionStages.domTranscriptPanel.rowCount = rows.length;
    summary.extractionStages.domTranscriptPanel.success = rows.length > 0;

    if (rows.length > 0) {
      console.log(`[extract] DOM transcript panel succeeded (${rows.length} rows).`);
    } else {
      console.log("[extract] DOM transcript panel returned 0 rows. Trying caption-track fallback...");
      summary.extractionStages.captionTrackFallback.attempted = true;
      rows = await extractTranscriptRowsFromCaptionTrack(page, videoId);
      summary.extractionStages.captionTrackFallback.rowCount = rows.length;
      summary.extractionStages.captionTrackFallback.success = rows.length > 0;
      summary.extractionMode = "caption-track-fallback";
    }

    if (rows.length > 0 && summary.extractionStages.captionTrackFallback.attempted) {
      console.log(`[extract] Caption-track fallback succeeded (${rows.length} rows).`);
    }

    if (rows.length === 0) {
      console.log("[extract] Caption-track fallback returned 0 rows. Trying youtube-transcript library fallback...");
      summary.extractionStages.youtubeTranscriptLibraryFallback.attempted = true;
      rows = await extractTranscriptRowsWithLibrary(videoUrl, videoId);
      summary.extractionStages.youtubeTranscriptLibraryFallback.rowCount = rows.length;
      summary.extractionStages.youtubeTranscriptLibraryFallback.success = rows.length > 0;
      summary.extractionMode = "youtube-transcript-library";
    }

    if (summary.extractionStages.youtubeTranscriptLibraryFallback.attempted) {
      if (rows.length > 0) {
        console.log(`[extract] youtube-transcript library fallback succeeded (${rows.length} rows).`);
      } else {
        console.log("[extract] youtube-transcript library fallback returned 0 rows.");
      }
    }

    if (
      summary.extractionStages.domTranscriptPanel.success &&
      !summary.extractionStages.captionTrackFallback.attempted &&
      !summary.extractionStages.youtubeTranscriptLibraryFallback.attempted
    ) {
      summary.extractionMode = "transcript-panel";
    }

    const selectedSource =
      summary.extractionMode === "transcript-panel"
        ? "DOM"
        : summary.extractionMode === "caption-track-fallback"
          ? "Caption Track"
          : "Library";
    summary.selectedSource = selectedSource;
    console.log(`[extract] Selected source: ${selectedSource}`);

    summary.transcriptCount = rows.length;
    summary.outlineMode = detectOutlineMode(videoTitle, rows).kind;

    const html = await page.content();
    await writeFile(path.join(runDir, "page.html"), html, "utf8");

    const csv = stringify(rows, {
      header: true,
      columns: ["index", "timestamp", "startSeconds", "text", "deepLink"],
    });
    await writeFile(path.join(runDir, "transcript.csv"), csv, "utf8");
    await writeFile(path.join(runDir, "transcript.json"), JSON.stringify(rows, null, 2), "utf8");

    const outline = await generateOutlineWithLlm(rows, videoTitle, videoUrl);
    await writeFile(path.join(runDir, "outline.md"), outline, "utf8");
    await writeFile(path.join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2), "utf8");

    console.log(`Saved artifacts in: ${runDir}`);
    console.log(`Transcript rows: ${rows.length}`);
    console.log(`Description expanded: ${summary.descriptionExpanded}`);
    console.log(`Transcript opened: ${summary.transcriptOpened}`);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pipeline failed: ${message}`);
  process.exitCode = 1;
});
