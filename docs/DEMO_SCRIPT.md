# Demo script — ~2.5 minutes

The goal of the video is to show the one thing plain MCP can't: an agent and a human
investigating **sensitive** data on the same page, with every disclosure governed and
visible. Record in an agent-capable browser (ChatGPT desktop app with site tools on, or
Chrome with the experimental flag). Keep the disclosure log visible the whole time.

Timings are a guide. The three moments that must land: **the gate blocking sensitive
data**, **the human editing the agent's SQL**, and **the agent rejecting its own
hypothesis**.

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

### 0:55 — The gate blocks sensitive data (25s) ⭐
Prompt: **"Is it a specific operator? Pull the operator-level numbers for LINE-2 night
shift."** The agent tries an operator-level aggregate — and the **k-anonymity floor
withholds the small groups**. The tool tells the agent several groups were suppressed
because they had fewer than five runs. If the agent then calls `requestRows` for the raw
operator records, the **disclosure dialog** appears: it names `operator_id` as sensitive
and warns the set is too small. **Click Deny.** A red `denied` entry lands in the log. Say:
*"It doesn't get individual operator data — that stays on my side."*

### 1:20 — Hypotheses on the board (20s)
Prompt: **"Put up your two leading hypotheses."** The agent calls `addHypothesis` twice —
e.g. *"night-shift staffing is the cause"* and *"a specific line/equipment issue is the
cause."* Two open cards appear with confidence bars.

### 1:40 — The human corrects the agent (25s) ⭐
Point out the trap: planned-maintenance downtime is inflating the night-shift numbers. In
the SQL editor, **edit the agent's query yourself** to exclude it — add
`WHERE downtime_reason <> 'Planned Maintenance'` — and run it. The grid updates on your
side. Prompt: **"I've excluded planned maintenance — re-read the workspace and re-evaluate."**
The agent calls `getWorkspaceContext`, sees *your* edited SQL, and continues from it. This
is the co-presence beat: it picked up a change you made on the page.

### 2:05 — The agent rejects its own hypothesis (20s) ⭐
With planned maintenance gone, the agent runs aggregates filtered to real faults and finds
the loss concentrated on **LINE-2, C shift, during the fault window**, tracking low
`filler_pressure_psi`. It calls `updateHypothesis`: **rejects** the staffing hypothesis and
marks the **equipment** hypothesis supported, attaching the SQL as evidence. The cards flip
status live.

### 2:25 — Reproducible close (10s)
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
3. Is it a specific operator? Pull the operator-level numbers for LINE-2 night shift.
4. Put up your two leading hypotheses.
5. *(after editing the SQL yourself)* I've excluded planned maintenance — re-read the workspace and re-evaluate.
6. Export the investigation.
