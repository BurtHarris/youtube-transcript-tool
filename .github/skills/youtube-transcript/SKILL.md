---
name: youtube-transcript
description: "Use when given a YouTube video URL to capture page HTML, extract transcript/timeline with timestamps, save structured output, and generate an outline markdown file."
argument-hint: "YouTube URL"
---

# YouTube Transcript Workflow

1. Validate the provided YouTube URL.
2. Capture full page HTML after opening transcript UI.
3. Extract transcript rows with timestamps and deep links.
4. Save CSV output into the working directory.
5. When the video title or transcript indicates a list-style format (for example: tips, steps, options, rules, or similar), generate a high-level structured outline using those list cues.
6. Prepend every outline with a metadata block and a linked title for the source video.
7. Use markdown reference-style links so repeated video URLs stay centralized in link definitions.
8. Generate H2-only markdown outline with topic, timestamp, and link.
