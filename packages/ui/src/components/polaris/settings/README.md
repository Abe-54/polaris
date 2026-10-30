# Settings kit

These are the parts every redesigned Settings page is built from (DESIGN.md, "Settings redesign (ENG-573)"; Paper "Settings redesign", artboard SR-Kit). Import them from `@polaris/ui`. To see every part in dark, Midnight and light, open the gallery with `bun run --cwd packages/ui gallery` and go to `?only=settings&density=calm|balanced|compact`.

Spacing comes only from the density tokens (`gap`, `panel`, `section`), so every part follows Calm, Balanced and Compact. Closed selects and steppers sit on `raised-control`, which is `#1C1D21` in Midnight.

## Page

**`SettingsPage`** takes `title`, `blurb` (one line), and optionally `scope` and `scopeIcon`. It draws the header (a 22px Semibold title, the blurb in `text-subtle`, and the scope pill on the right), then lays its children out in a column about 860px wide, 8px apart at Calm.

```tsx
<SettingsPage title="Sessions" blurb="How new agent sessions start, and what happens while they run."
  scope="This Mac · archive and setup per host" scopeIcon={<ScreenGlyph />}>
  …cards…
</SettingsPage>
```

**`SettingsScope`** is the pill on its own, for a header you build yourself: `<SettingsScope icon={…}>Each host</SettingsScope>`.

**`SettingsGrid`** puts two cards side by side, and drops to one column when its own width falls below about 760px (a container query, so the window size doesn't matter).

```tsx
<SettingsGrid><IdleCompactionCard /><ArchiveCard /></SettingsGrid>
```

## Cards

**`SettingsCard`** is HS-D's instrument card. It takes `title`, an optional `aside` (a summary string or one control), an optional `status` (the footer's mono line), and an optional `action` (one `SettingsButton`). Its children are one or two wells.

**`SettingsWell`** is an inset well. Its rows get hairline dividers; pass `rows={false}` when the well holds free content such as instruments.

```tsx
<SettingsCard title="While sessions run" aside="4 of 5 on"
  status="macOS notifications · your phone has its own switch"
  action={<SettingsButton>Open notification settings</SettingsButton>}>
  <SettingsWell>…rows…</SettingsWell>
</SettingsCard>
```

## Rows (inside a `SettingsWell`)

Every row takes `title` and `caption` (one line each), plus `nested` (indents it under the row it depends on) and `dimmed` (55% opacity, for when that row is off).

**`SettingsRow`** is a setting with any control in its trailing lane: `<SettingsRow title="…" caption="…"><SettingsButton variant="ghost">Unhide</SettingsButton></SettingsRow>`.

**`SettingsToggleRow`** takes `checked` and `onCheckedChange`, and draws the 30×18 `SettingsSwitch`.

```tsx
<SettingsToggleRow title="Notify when a session needs you" caption="Unless Polaris is showing that session"
  checked={notify} onCheckedChange={setNotify} />
```

**`SettingsStepperRow`** takes `value`, `onChange`, `min`, `max`, `step` and `format`. Each press snaps the value to a multiple of `step`, and the button that would pass a bound is disabled.

```tsx
<SettingsStepperRow title="Minimum context" value={min} onChange={setMin}
  min={50_000} max={1_000_000} step={50_000} format={(n) => `${n / 1000}k`} />
```

**`SettingsSelectRow`** takes `value`, `options`, `onChange` and `placeholder`. Each option is `{ value, label, short? }`: the closed select shows `short` when an option has one, and the menu always shows the full `label`.

```tsx
<SettingsSelectRow title="Where accepted turns are committed" value={mode} onChange={setMode}
  options={[{ value: "default", label: "Branch only from the default branch", short: "Branch from default" }, …]} />
```

**`SettingsHostRow`** takes `name`, `colour` (the host's own colour), `fact` (one mono line) and `offline`, with the control as its children. The lanes are fixed: the colour square, a 160px name, the fact, then the control. An offline host dims to 55% and shows a dashed "Not connected" where its control would be.

```tsx
<SettingsHostRow name="Mac Studio" colour={host.colour} fact="macOS arm64" offline={!connected}>
  <SettingsSelect label="Mac Studio" value={v} options={ARCHIVE} onChange={set} />
</SettingsHostRow>
```

**`SettingsOverrideRow`** takes `name`, `value` (`null` means the row follows its default), `options`, `defaultLabel`, `onChange` and `parent` (default "the host"). Its first choice reads "Default · {defaultLabel}". The caption says "Follows the host" or "Overrides the host". Pass `caption` to show the row's own line instead ("12.4 MB in 8 files"). A × button clears the override, and the space for it is kept even when there is no override, so rows stay aligned.

```tsx
<SettingsOverrideRow name="dotfiles" value={override} options={ARCHIVE}
  defaultLabel="After 7 days" onChange={setOverride} />
```

**`SettingsConfirmRow`** confirms a destructive action in place, never in a modal. It takes `title`, `caption`, `action` (the row's button that asks), `actionVariant` (`danger` by default; `secondary` for a routine row action such as Revoke or Unlink, SR-07 and SR-08), `consequence`, `confirm` (a label that names its object), `onConfirm`, and `disabledReason` (disables the action and replaces the caption with the reason). Its children are other row actions, shown beside the action.

While it asks, the row takes a faint `failed` tint, the caption becomes the consequence, and Cancel holds focus. Esc cancels and puts focus back on the action.

```tsx
<SettingsConfirmRow title="Even G2" caption="Read · approve · used 3h ago" action="Revoke"
  consequence="Revoking disconnects it now. To use it again, pair it again."
  confirm="Revoke Even G2" onConfirm={() => revoke(id)} />
```

## Empty states

**`SettingsEmpty`** is one caption line in a well, used in place of an empty list: `<SettingsEmpty>No hidden workspaces</SettingsEmpty>`.

**`SettingsEmptyTile`** takes `icon`, `title`, `caption` and `action`. It draws a 40px Starlight tile, one sentence and a caption, with one action.

```tsx
<SettingsEmptyTile icon={<PhonePixel />} title="No linked devices"
  caption="Link your phone once; it reaches every relay host."
  action={<SettingsButton>Link a device</SettingsButton>} />
```

## Controls and buttons

**`SettingsSwitch`**, **`SettingsStepper`** (which needs a `label` for its buttons) and **`SettingsSelect`** (which needs a `label`) are the rows' controls, for use on their own.

**`SettingsButton`** is the 28px pill (DESIGN.md, rule/buttons-where-you-click). Its `variant` is one of:

- `primary`: the page's one primary action. A card never holds it.
- `secondary` (the default): card footers, and links to another page ("Hosts…").
- `ghost`: has a hairline, so a row action still reads as a button ("Unhide", "Cancel").
- `danger`: names its object ("Revoke Even G2").
- `quiet`: text only, and only for a secondary action beside a more important one (Reset).

```tsx
<SettingsButton variant="ghost" onClick={unhide}>Unhide</SettingsButton>
```
