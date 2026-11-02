from solution import count_by_hour
L = ["2026-03-01 00:59:59 INFO a", "2026-03-01 01:00:00 INFO b", "2026-03-01 01:30:00 WARN c", "2026-03-01 02:00:00 INFO d"]
assert count_by_hour(L, "2026-03-01 00:00:00", "2026-03-01 02:00:00") == {"2026-03-01 00": 1, "2026-03-01 01": 2}
assert count_by_hour(L, "2026-03-01 05:00:00", "2026-03-01 06:00:00") == {}
assert count_by_hour([], "2026-03-01 00:00:00", "2026-03-02 00:00:00") == {}
print("visible tests passed")
