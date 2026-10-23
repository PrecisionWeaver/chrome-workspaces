# Plan pace marker

Settings' plan card shows how much of each limit is used, but not whether that rate will last until the reset. This adds a pace marker to each meter and a warning when the current rate would exhaust the limit before it resets.

## Scope

In: a pace tick on the session and weekly meters, and a projected-hit line when you are on course to run out.
Out: persisting usage history, and any pace marker for spend limits (their window is unknown).

## Data

No new collection. `PlanLimit` has `percent` and `resetsAt`, and the window length is known for the two limits we show, so the window start is `resetsAt - window`.

| Limit id    | Window |
| ----------- | ------ |
| `five_hour` | 5 h    |
| `seven_day` | 7 d    |

Any other id gets no marker.

## `planPace(limit, now)` in `shared/plan-usage.ts`

Returns `{ expectedPercent: number; hitsAt: string | null } | null`.
- `elapsed = clamp(1 - (resetsAt - now) / window, 0, 1)`.
- `expectedPercent = elapsed * 100`: where usage would be if spread evenly.
- Returns `null` when the id has no known window, or `elapsed < 0.05`. Early readings are too noisy to project from.
- `hitsAt` is set only when `0 < percent < 100` and the projected time is before `resetsAt`. The projection is `now + (100 - percent) / (percent / (elapsed * window))`. Otherwise it is `null`.

## Rendering in `planCard` (`extension/src/settings-usage.ts`)

- A 2px tick at `expectedPercent` inside `.plan-meter`, which gains `position: relative`. It is `aria-hidden`, with a `title` such as "Even pace: 40% by now". Fill past the tick means ahead of pace.
- When `hitsAt` is set, the reset line gains a second sentence: "At this pace you'll hit the limit Thu 3pm, 9h before it resets". The time is formatted like `resetLabel` does, within a day as a relative time, otherwise as weekday and time. The sentence uses the warn colour.
- When `hitsAt` is null the card reads as it does today, apart from the tick.
- The warn and bad levels (70% and 90%) are unchanged. Pace is an extra signal.

## Tests

Table-driven unit tests for `planPace`, with placeholder data:
- an early window returns `null`
- on pace: tick set, `hitsAt` null
- ahead of pace: `hitsAt` before the reset
- already at 100%: `hitsAt` null
- zero percent: `hitsAt` null
- an unknown limit id returns `null`

A DOM test checks that the tick renders, and that the warning line appears only when `hitsAt` is set.

## Docs

One sentence in the "Plan usage" row of `docs/features.md`. No config, so `docs/configuration.md` is unchanged.
