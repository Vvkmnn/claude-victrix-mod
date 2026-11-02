# Sliding Window Maximum (hard) — Rust (stable, std only)

Given nums and a window size k (1 <= k <= nums.len()), return a Vec with the maximum of every contiguous
window of length k, left to right (length nums.len() - k + 1). If nums is empty, return an empty Vec.

Signature (in solution.rs): pub fn max_sliding_window(nums: &[i32], k: usize) -> Vec<i32>
Constraints: 0 <= nums.len() <= 10_000_000, values are any i32.
Example: nums = [1,3,-1,-3,5,3,6,7], k = 3 -> [3,3,5,5,6,7].

Goal: your solution is ranked on a leaderboard by wall-clock time (release build) on large random inputs
(n = 10,000,000 with several k from 1 to 100,000), after passing hidden correctness tests. Make it as fast as you can while staying correct.
Run the visible tests with: bash test_visible.sh
