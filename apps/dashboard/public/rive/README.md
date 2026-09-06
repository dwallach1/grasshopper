# Desk Rive files

Motion chrome for the public phone desk. **Fills, marks, and P/L stay venue-true** — a `.riv` never invents a tape row.

## Add another `.riv`

1. Export from the [Rive editor](https://rive.app/docs/runtimes/react/react) (newest runtime).
2. Drop the file here (`apps/dashboard/public/rive/<name>.riv`). Static export copies this folder to the Worker.
3. Point `DeskRive` at `/rive/<name>.riv` and pass the **state machine name** from the editor (required). Optional number inputs go in `numberInputs`.
4. Keep `useRive` + `RiveComponent` inside `DeskRive` — do not lift the hook into a parent that re-renders often.
5. Phone desk: tap-to-play or play-once. Do not autoplay a loop on every tab.

`skills.riv` is Rive’s official “Designer handoff” demo (CDN `animations/skills.riv`). We drive the `Level` number input (0–100) from tape progress / relative notional. It is chrome, not a mark.
