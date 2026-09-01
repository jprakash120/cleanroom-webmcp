#!/usr/bin/env python3
"""
generate_data.py — synthetic beverage-manufacturing production runs for Cleanroom.

Everything here is fabricated. No real operators, products, or facilities.
The data has a deliberate, discoverable root-cause story so the WebMCP demo has
something real for a human + agent to investigate together:

    Symptom : total output is down and it looks worst on the C (night) shift.
    Trap    : a naive "downtime -> low output" cut blames the night shift and
              individual operators, because PLANNED maintenance downtime is
              mixed in and inflates night-shift downtime.
    Truth   : once planned maintenance is excluded, the real driver is a
              filler-pressure fault on LINE-2 during the C shift over a two-week
              window (low filler_pressure_psi -> Filler Jam -> lost units).
              It is a line/equipment problem, not a people problem.

`operator_id` is the sensitive column. Grouping by `operator_id` alone does NOT
trip the k-anonymity floor on this dataset — each operator has 11-16 runs overall.
Crossing it with a second dimension (e.g. `downtime_reason`, filtered to LINE-2 /
C-shift) does: several of those combinations fall under 5 runs, which is what
forces the disclosure gate to withhold groups (k = 5). Tested: grouping by
[operator_id, downtime_reason] on LINE-2/C shares 3 groups and withholds 16.

Run:  python3 generate_data.py
Out:  production_runs.csv
"""

import argparse
import csv
import random
from datetime import date, timedelta

SEED = 20260903          # submission deadline, for luck

START = date(2026, 6, 1)
DAYS = 62                 # ~2 months of runs (default, committed sample)
SHIFTS = ["A", "B", "C"]  # A=day, B=swing, C=night
LINES = ["LINE-1", "LINE-2", "LINE-3"]
SKUS = ["COLA-12OZ", "LEMON-16OZ", "SPRING-1L", "ENERGY-8OZ", "TONIC-10OZ"]

# Nominal planned output per line/shift (units)
PLANNED_BASE = {"LINE-1": 9800, "LINE-2": 11200, "LINE-3": 8600}

# Downtime reasons and their rough baseline probability on a normal run
REASONS_NORMAL = [
    ("None", 0.52),
    ("Changeover", 0.18),
    ("Planned Maintenance", 0.10),
    ("Label Misfeed", 0.08),
    ("Capper Fault", 0.06),
    ("Sensor Fault", 0.04),
    ("Filler Jam", 0.02),
]

# Operator pool, assigned per line so some line/shift slices stay small (k-anon)
OPERATORS = [f"OP-{1000+i}" for i in range(28)]


def weighted_choice(pairs):
    r = random.random()
    acc = 0.0
    for value, w in pairs:
        acc += w
        if r <= acc:
            return value
    return pairs[-1][0]


def in_fault_window(d: date) -> bool:
    """The LINE-2 filler-pressure fault window: two weeks in late July."""
    return date(2026, 7, 20) <= d <= date(2026, 8, 2)


def pick_operator(line: str, shift: str) -> str:
    # Deterministic-ish operator pools per line so slices stay realistically small.
    idx = (LINES.index(line) * 9) + (SHIFTS.index(shift) * 3)
    pool = OPERATORS[idx: idx + 4] or OPERATORS[:4]
    return random.choice(pool)


def make_run(run_id: int, d: date, shift: str, line: str):
    sku = random.choice(SKUS)
    planned = PLANNED_BASE[line] + random.randint(-400, 400)

    reason = weighted_choice(REASONS_NORMAL)
    filler_pressure = round(random.gauss(38.0, 1.4), 1)   # nominal band ~36-40 psi
    fill_temp = round(random.gauss(4.2, 0.4), 1)          # cold-fill target ~4C

    # ---- inject the root-cause story -------------------------------------
    faulted = (line == "LINE-2" and shift == "C" and in_fault_window(d))
    if faulted:
        # Filler pressure sags below the nominal band on the night shift.
        filler_pressure = round(random.gauss(31.5, 1.1), 1)
        # Low pressure drives jams / sensor faults.
        reason = weighted_choice([
            ("Filler Jam", 0.55),
            ("Sensor Fault", 0.25),
            ("None", 0.12),
            ("Changeover", 0.08),
        ])

    # Night shift is a little slower everywhere (fatigue), but only mildly.
    shift_factor = {"A": 1.00, "B": 0.985, "C": 0.965}[shift]

    # Downtime minutes by reason
    downtime = {
        "None": random.randint(0, 8),
        "Changeover": random.randint(20, 45),
        "Planned Maintenance": random.randint(60, 140),
        "Label Misfeed": random.randint(10, 30),
        "Capper Fault": random.randint(15, 40),
        "Sensor Fault": random.randint(25, 70),
        "Filler Jam": random.randint(45, 120),
    }[reason]

    # Output: start from planned, apply shift factor, then subtract losses.
    # Downtime costs throughput; low filler pressure costs extra on faulted runs.
    per_min_rate = planned / 480.0  # 8h shift
    downtime_loss = downtime * per_min_rate
    pressure_penalty = 0.0
    if filler_pressure < 34.0:
        pressure_penalty = (34.0 - filler_pressure) * per_min_rate * 6.0

    actual = planned * shift_factor - downtime_loss - pressure_penalty
    actual += random.gauss(0, 120)  # noise
    actual = max(0, int(round(actual)))

    # Rejects rise with jams / low pressure
    reject_rate = 0.004
    if reason in ("Filler Jam", "Capper Fault"):
        reject_rate += 0.02
    if filler_pressure < 34.0:
        reject_rate += 0.015
    rejects = max(0, int(actual * max(0, random.gauss(reject_rate, 0.003))))

    qa_pass = (rejects / actual < 0.03) if actual else False

    return {
        "run_id": run_id,
        "run_date": d.isoformat(),
        "shift": shift,
        "line_id": line,
        "product_sku": sku,
        "planned_units": planned,
        "actual_units": actual,
        "downtime_min": downtime,
        "downtime_reason": reason,
        "reject_units": rejects,
        "filler_pressure_psi": filler_pressure,
        "fill_temp_c": fill_temp,
        "operator_id": pick_operator(line, shift),
        "qa_pass": str(qa_pass).lower(),
    }


def messify(row):
    """Introduce realistic dirt so the loader's error-tolerant path gets exercised.
    Only used with --messy. The LINE-2 fault story stays intact for the values that
    matter, but formatting, blanks, and stray types show up the way real exports do."""
    # stray whitespace / inconsistent casing on the SKU
    if random.random() < 0.15:
        row["product_sku"] = f"  {row['product_sku']} "
    # blank out low-importance fields sometimes (missing values)
    if random.random() < 0.06:
        row["fill_temp_c"] = ""
    if random.random() < 0.05:
        row["downtime_reason"] = ""
    if random.random() < 0.04:
        row["operator_id"] = ""
    # occasional non-numeric junk in a numeric column
    if random.random() < 0.02:
        row["reject_units"] = random.choice(["n/a", "NaN", "-"])
    # inconsistent date format on a minority of rows
    if random.random() < 0.08:
        y, m, dd = row["run_date"].split("-")
        row["run_date"] = f"{m}/{dd}/{y}"
    # inconsistent boolean spelling
    if random.random() < 0.05:
        row["qa_pass"] = random.choice(["Y", "N", "TRUE", "FALSE", "1", "0"])
    return row


def main():
    ap = argparse.ArgumentParser(description="Generate synthetic production runs.")
    ap.add_argument("--rows", type=int, default=None,
                    help="approximate target row count (scales batches to hit it)")
    ap.add_argument("--days", type=int, default=DAYS, help="number of days of runs")
    ap.add_argument("--batches", type=int, default=1,
                    help="production batches per line per shift per day")
    ap.add_argument("--messy", action="store_true",
                    help="inject missing values, bad types, and inconsistent formats")
    ap.add_argument("--out", default="production_runs.csv", help="output CSV path")
    ap.add_argument("--seed", type=int, default=SEED)
    args = ap.parse_args()
    random.seed(args.seed)

    days = args.days
    batches = args.batches
    # If a target row count is given, scale batches (keeping the date range readable).
    if args.rows:
        days = max(days, 365)
        per_day = len(LINES) * len(SHIFTS) * 0.95
        batches = max(1, round(args.rows / (days * per_day)))

    rows = []
    run_id = 50000
    for day_offset in range(days):
        d = START + timedelta(days=day_offset)
        weekday = d.weekday()
        shifts_today = SHIFTS if weekday != 6 else ["A"]  # Sunday = maintenance only
        for shift in shifts_today:
            for line in LINES:
                for _ in range(batches):
                    if random.random() < 0.05:  # occasional line not scheduled
                        continue
                    run_id += 1
                    row = make_run(run_id, d, shift, line)
                    if args.messy:
                        row = messify(row)
                    rows.append(row)

    fields = list(rows[0].keys())
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    # Console summary so the generator is self-documenting.
    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    total_planned = sum(num(r["planned_units"]) for r in rows)
    total_actual = sum(num(r["actual_units"]) for r in rows)
    print(f"wrote {args.out}  rows={len(rows):,}  messy={args.messy}")
    if total_planned:
        print(f"overall attainment = {total_actual/total_planned:0.1%}")
    print("Tip: large/messy files are for the file picker — do not commit them.")


if __name__ == "__main__":
    main()
