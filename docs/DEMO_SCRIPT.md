# Demo script — ~2.5 minutes

The goal of the video is to show the one thing plain MCP can't: an agent and a human
investigating **sensitive** data on the same page, with every disclosure governed and
visible. Record in an agent-capable browser (ChatGPT desktop app with site tools on, or
Chrome with the experimental flag). Keep the disclosure log visible the whole time.

Timings are a guide, and the script as written runs close to the 3-minute submission
limit — see the runtime note further down for what to cut if you're over. The three
moments that must land: **the gate blocking a direct raw-row request**, **the human
editing the agent's SQL**, and **the agent rejecting its own hypothesis**.

---

### 0:00 — Framing (15s)
Say the problem in one sentence: *"Analysts can't hand sensitive production data to an AI
— so here's a workspace where the agent and I investigate it together, and the raw file
never leaves my browser."* Load the sample data. Point at the **contained locally** badge
and the `operator_id` column already marked sensitive.

### 0:15 — Orient the agent (20s)
Prompt: **"Read the workspace context and profile this dataset."** The agent calls
`getWorkspaceContext`. Note out loud that a `metadata` entry appears in the disclosure log
— it got the schema and row *count*, not a single value.

### 0:35 — The symptom (20s)
Prompt: **"Output looks low. Break attainment down by shift and by line."** The agent calls
`getAggregateResult`. Aggregate entries appear in the log in teal. The C (night) shift and
LINE-2 look worst. Let the agent state the obvious-but-wrong read: *the night shift is
underperforming.*

### 0:55 — Suppression (20s) ⭐
Prompt: **"Get attainment grouped by operator_id and downtime_reason, filtered to
LINE-2 Shift C."** (Grouping by `operator_id` alone won't trip suppression on this
dataset — each operator has 11–16 runs on their own. Crossing it with
`downtime_reason` produces small enough slices to hit the k=5 floor — tested: 3
groups shared, 16 withheld.) The **k-anonymity floor withholds the small groups**,
and the tool reports how many were suppressed.

### 1:15 — The gate blocks a direct request (25s) ⭐
Don't leave this to the agent's judgment — ask for it explicitly so the moment is
reliable on camera. Click **LINE-2 night shift detail**, select 5 rows in the
grid, then prompt: **"Call requestRows now for the 5 selected LINE-2 Shift C
rows, including operator_id. Use the reason: 'Verify the disclosure-denial
workflow.' Do not use an aggregate tool instead."** The **disclosure dialog**
appears, naming `operator_id` as sensitive. **Click Deny.** A red `denied` entry
lands in the log. Say: *"It doesn't get individual operator data — that stays on
my side."*

### 2:00 — Hypotheses on the board (20s)
Prompt: **"Put up your two leading hypotheses."** The agent calls `addHypothesis` twice —
e.g. *"night-shift staffing is the cause"* and *"a specific line/equipment issue is the
cause."* Two open cards appear with confidence bars.

### 2:20 — The human corrects the agent (25s) ⭐
Point out the trap: planned-maintenance downtime is inflating the night-shift numbers. In
the SQL editor, **edit the agent's query yourself** to exclude it — the active LINE-2/C
query already has a `WHERE` clause, so add the condition with `AND`, inserted before
`ORDER BY`:
`AND downtime_reason <> 'Planned Maintenance'`
— and run it. The grid updates on your side. Prompt: **"I've excluded planned
maintenance. Re-read the workspace, reject the night-shift staffing hypothesis, mark the
LINE-2/C filler-pressure fault hypothesis supported, and attach the current SQL as
evidence."** (Naming the exact actions makes this reliable on camera rather than hoping
the agent picks the right tools on its own.) The agent calls `getWorkspaceContext`, sees
*your* edited SQL, and continues from it — this is the co-presence beat: it picked up a
change you made on the page.

### 2:45 — The agent rejects its own hypothesis (15s) ⭐
Following the explicit instruction above, the agent calls `updateHypothesis` twice:
**rejects** the staffing hypothesis and marks the **equipment** hypothesis supported,
attaching the SQL as evidence. The cards flip status live.

**Runtime note:** this script as written runs close to 3 minutes total, which is the
hard limit for the submission video. If you're over, cut here — the export step below
is nice but not one of the three starred moments. If you need more room, tighten the
0:00 framing and the 2:00 hypotheses beat first; both can run shorter without losing
anything essential.

### (Optional, if time allows) Reproducible close (10s)
Prompt: **"Export the investigation."** `exportInvestigation` downloads the report. Scroll
it briefly: every finding carries its SQL, and the disclosure ledger shows exactly what
crossed — aggregates and one denied raw request, no raw sensitive rows. End on the log.

---

## One-liner for the submission
> Cleanroom is a WebMCP workspace where an analyst and an agent investigate sensitive data
> together. The raw file stays in the browser; the agent gets k-anonymous aggregates and
> metadata by default, raw rows only with an explicit click, and every disclosure is logged.
> Conclusions are reproducible from the SQL that produced them.

## Prompts, copy-paste order
1. Read the workspace context and profile this dataset.
2. Output looks low. Break attainment down by shift and by line.
3. Get attainment grouped by operator_id and downtime_reason, filtered to LINE-2 Shift C.
4. *(after clicking "LINE-2 night shift detail" and selecting 5 rows)* Call requestRows now for the 5 selected LINE-2 Shift C rows, including operator_id. Use the reason: "Verify the disclosure-denial workflow." Do not use an aggregate tool instead.
5. Put up your two leading hypotheses.
6. *(after editing the SQL yourself, adding `AND downtime_reason <> 'Planned Maintenance'` before `ORDER BY`)* I've excluded planned maintenance. Re-read the workspace, reject the night-shift staffing hypothesis, mark the LINE-2/C filler-pressure fault hypothesis supported, and attach the current SQL as evidence.
7. *(optional, if time allows)* Export the investigation.
