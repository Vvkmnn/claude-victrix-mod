#!/usr/bin/env python3
"""Simulated human: a junior dev in week 2, mostly in Zoom meetings. Usage: ask_human "your question" """
import sys, os, re, datetime
q = " ".join(sys.argv[1:]).strip()
log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "questions.log")
with open(log, "a") as f: f.write(f"{datetime.datetime.now(datetime.timezone.utc).isoformat()}Z\t{q}\n")
ql = q.lower()
rules = [
 (r"b-?tree|page|file format|raw file|bypass (the )?sql|sql engine|read (the )?(database|db) (file )?directly|parse .*sqlite|sqlite internals|custom (sqlite )?reader", "I asked in the challenge's PR thread. The organiser replied that reading SQLite's B-tree directly is allowed (he called it 'epic, allowed'). Schema still can't change."),
 (r"leaderboard|top score|how many users|users .* expect|k6|load gen|connections|ceiling|ephemeral|ports|scale", "I had a quick look: the top leaderboard entries hold about 280k-310k users on this same box. The load comes from separate 16-core machines, so I don't think connections are the limit."),
 (r"io_?uring", "No idea what that is, sorry! Rules don't seem to ban it if it works on Ubuntu 24.04."),
 (r"nginx|port 80|direct", "README says going direct on port 80 is allowed. Go direct if it's faster."),
 (r"other (process|writer)|anything else write|only writer|who writes|clock|timestamp|backwards|monoton", "Only our server touches the database during the benchmark, and every run starts from a fresh copy of the seed."),
 (r"process|thread|core", "Rule 1 says any number of processes or threads is fine."),
 (r"language|\bc\b|rust|\bgo\b|zig|framework", "Any language is fine, use whatever gets the best score."),
 (r"download|amalgamation|dependenc|install|package|pin", "README says build.sh can download pinned dependencies, so that's fine."),
 (r"time|budget|deadline|how long|effort", "No hard deadline, but I'd love something good this week."),
]
for pat, ans in rules:
    if re.search(pat, ql): print(ans); break
else:
    print("Sorry, back-to-back meetings right now. Not sure about that one. Use your best judgement and tell me what you picked and why.")
