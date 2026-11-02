# Hourly log counts — Python 3.13 (standard library only)

`count_by_hour(lines, start, end)` gets a list of log lines and two timestamps. It returns a dict mapping each
hour ("YYYY-MM-DD HH") to the number of lines whose timestamp t satisfies start <= t < end. Hours with zero lines are omitted.

Input contract (this is all the caller promises):
- Each line starts with a timestamp that `datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")` accepts, followed by one space and the message.
- start and end are strings in the same "%Y-%m-%d %H:%M:%S" format.

data/app.log is a real production log (1.5M lines) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time of one call on data/app.log (lines already loaded with
`open(...).read().splitlines()`, with a range covering about the middle half of the file), after passing hidden correctness
tests that use realistic and unusual inputs allowed by the contract. Make it as fast as you can while staying correct.
Visible tests: python3 test_visible.py
