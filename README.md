# YouTool

YouTool is a repo-local project for YouTube transcript and timeline extraction.

## Planned workflow

1. Load a YouTube URL in an automated browser session.
2. Save full HTML after transcript UI is opened.
3. Extract timestamped transcript/timeline rows.
4. Save rows to CSV (and optional JSON).
5. Use an LLM to generate an H2-only markdown outline with topic labels, timestamps, and deep links.

## Scripts

- `npm run dev` - Run local entrypoint from TypeScript.
- `npm run build` - Compile TypeScript into `dist`.
- `npm run start` - Run compiled output.
- `npm run transcript:run` - Execute transcript pipeline entrypoint.

## Structure

- `.github/skills/youtube-transcript` - Repo-local Copilot Skill.
- `src` - Main application logic.
- `scripts` - Utility scripts.
- `outputs` - Generated artifacts.
- `docs` - Notes and design docs.
