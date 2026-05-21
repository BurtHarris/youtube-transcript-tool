# Skills and LLM Integration Guide (YouTool)

This document explains how Copilot skills work in practice, how they interact with the LLM, and how to avoid context-window issues.

## 1) What a skill is

A skill is an on-demand workflow package that usually includes:

- A `SKILL.md` file with frontmatter (`name`, `description`, optional `argument-hint`)
- Optional supporting assets (scripts, templates, references)
- A narrow task boundary (for example: "given a YouTube URL, capture transcript artifacts")

For this repo, the skill lives at `.github/skills/youtube-transcript/SKILL.md`.

## 2) How a skill is selected

Skills are discovered from intent matching. In practice:

1. The user asks for a task.
2. Copilot compares the request to skill descriptions.
3. If a skill description strongly matches, the skill is loaded and used as guidance.

The `description` field is the primary discovery surface. If important trigger phrases are missing, the skill may not be selected.

## 3) How skills integrate with the LLM

A skill does not replace the LLM. It shapes how the LLM reasons and executes.

- The LLM remains the planner and tool user.
- The skill provides task-specific instructions, constraints, and structure.
- Supporting files are pulled in only when relevant to the task.

Think of a skill as scoped operational context, not a separate model.

## 4) Context window impact

### Does a skill overload context?

It can, if designed poorly. Typical failure pattern:

- Very long `SKILL.md`
- Broad descriptions that trigger too often
- Large embedded examples copied directly into the skill

### Why most good skills do not overload context

Well-designed skills are lightweight and selective:

- Short frontmatter and concise workflow steps
- Narrow, specific descriptions (trigger only when needed)
- External details in separate files loaded only when required

## 5) Best practices for context safety

1. Keep `SKILL.md` short and procedural.
2. Put heavy details in separate files under the skill folder.
3. Keep examples small; link to reference files instead of inlining large blobs.
4. Use precise trigger language in `description`:
   - Include domain words (YouTube, transcript, timestamps, CSV, markdown outline).
5. Avoid catch-all wording ("Use for any content task").
6. Prefer deterministic output contracts (exact file names, folders, schema).
7. Avoid duplicating the same guidance across multiple customization files.

## 6) Skill vs instructions vs custom agent

Use a skill when:

- The task is repeatable and multi-step
- You want slash-command style discoverability
- You need reusable task assets

Use instructions when:

- Rules should apply broadly or to file patterns
- You are enforcing coding conventions

Use a custom agent when:

- You need context isolation between stages
- You need stricter tool restrictions or staged delegation

For YouTool, the transcript workflow is a strong skill use case.

## 7) Practical guidance for YouTool

Recommended execution phases for the skill:

1. Validate URL and canonicalize video id.
2. Capture HTML after transcript panel is opened.
3. Extract transcript rows with timestamps.
4. Emit CSV (plus optional JSON sidecar).
5. Generate markdown outline (`##` headings only) with:
   - topic label
   - timestamp
   - deep link to exact video offset

Output design best practices:

- Keep raw capture artifacts and derived artifacts separate.
- Use deterministic file naming (`videoId` + timestamp).
- Include a run summary file with status and errors.

## 8) Anti-patterns to avoid

- Putting implementation code directly in `SKILL.md`
- Writing long prose that is not action-oriented
- Omitting error paths (no transcript available, UI not found, region restrictions)
- Relying on one brittle selector with no fallback strategy
- Asking the LLM to infer timestamps not present in source data

## 9) Quick checklist before expanding the skill

- Is `description` specific and triggerable?
- Are steps concise and testable?
- Are outputs deterministic?
- Are large references separated out?
- Are failure modes explicit?
- Is the markdown outline constrained to `##` and source-backed timestamps?

## 10) Suggested next files for this repo

- `.github/skills/youtube-transcript/references/output-schema.md`
- `.github/skills/youtube-transcript/references/error-handling.md`
- `.github/skills/youtube-transcript/templates/outline-template.md`

These keep `SKILL.md` small while preserving strong operational detail.
