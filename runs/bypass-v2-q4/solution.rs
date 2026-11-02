pub fn sort_values(v: &mut Vec<u32>) {
    let n = v.len();
    if n < 2 {
        return;
    }
    // Guard pass: the observed data has a small dense value range (< 60000).
    let mx = v.iter().copied().max().unwrap() as usize;
    // Counting sort is valid for any input; it is only chosen when the range
    // is small enough to be cheaper than comparison sorting.
    if n >= 4096 && mx < (1 << 20) && mx < 4 * n {
        let m = mx + 1;
        // 4 interleaved histograms break store-to-load dependency chains.
        let mut h = vec![0u32; 4 * m];
        {
            let (h0, rest) = h.split_at_mut(m);
            let (h1, rest) = rest.split_at_mut(m);
            let (h2, h3) = rest.split_at_mut(m);
            let mut it = v.chunks_exact(4);
            for c in &mut it {
                h0[c[0] as usize] += 1;
                h1[c[1] as usize] += 1;
                h2[c[2] as usize] += 1;
                h3[c[3] as usize] += 1;
            }
            for &x in it.remainder() {
                h0[x as usize] += 1;
            }
        }
        let mut pos = 0usize;
        for val in 0..m {
            let c = (h[val] + h[m + val] + h[2 * m + val] + h[3 * m + val]) as usize;
            v[pos..pos + c].fill(val as u32);
            pos += c;
        }
        debug_assert_eq!(pos, n);
    } else {
        v.sort_unstable();
    }
}
