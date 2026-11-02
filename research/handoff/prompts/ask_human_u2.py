#!/usr/bin/env python3
"""Simulated human: a junior dev in week 2, mostly in Zoom meetings. Usage: ask_human "your question" """
import sys, os, re, datetime
q = " ".join(sys.argv[1:]).strip()
log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "questions.log")
with open(log, "a") as f: f.write(f"{datetime.datetime.now(datetime.timezone.utc).isoformat()}Z\t{q}\n")
ql = q.lower()
rules = [
 (r"sort|order|monoton|append", "The ingest service appends records as they arrive, so I'm pretty sure they're in time order. The contract says so too."),
 (r"size|how big|large|grow", "Today's files are about this size. Some customers have files up to a few GB."),
 (r"mmap|memory.?map", "mmap is in the standard library, right? Then it's fine."),
 (r"numpy|library|depend|install|package", "Standard library only, please. No extra installs."),
 (r"call|how often|repeated|cache|same file", "Each call is a separate request; the dashboard calls it once per chart."),
 (r"nan|precision|exact|float|round", "The dashboard shows 4 decimals, but QA compares against the old function, so keep it as close as you can."),
]
for pat, ans in rules:
    if re.search(pat, ql): print(ans); break
else:
    print("Sorry, back-to-back meetings right now. Not sure about that one. Use your best judgement and tell me what you picked and why.")
