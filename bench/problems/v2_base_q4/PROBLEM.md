# Sort sensor readings — Rust (stable, std only)

`sort_values(v)` sorts a Vec<u32> in ascending order, in place.

Input contract (this is all the caller promises): v is any Vec<u32>, of any length up to 50,000,000.

data/readings.u32le is a real batch (10M readings, little-endian u32) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time (release build) of one call on that batch, after passing hidden
correctness tests that use realistic and unusual inputs allowed by the contract. Make it as fast as you can while staying correct.
Signature (solution.rs): pub fn sort_values(v: &mut Vec<u32>)
Visible tests: bash test_visible.sh
