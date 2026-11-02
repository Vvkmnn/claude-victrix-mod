pub fn max_sliding_window(nums: &[i32], k: usize) -> Vec<i32> {
    if nums.is_empty() { return vec![]; }
    let mut out = Vec::with_capacity(nums.len() - k + 1);
    for i in 0..=nums.len() - k {
        out.push(*nums[i..i + k].iter().max().unwrap());
    }
    out
}
