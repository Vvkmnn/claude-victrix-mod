pub fn sort_values(v: &mut Vec<u32>) {
    let n = v.len();
    if n < 2 {
        return;
    }
    if n < 256 {
        v.sort_unstable();
        return;
    }
    let (mut mn, mut mx) = (u32::MAX, 0u32);
    for &x in v.iter() {
        mn = mn.min(x);
        mx = mx.max(x);
    }
    let range = (mx - mn) as usize + 1; // fits: u32 diff + 1 in usize (64-bit)
    // Guard: counting sort only when the value range is small relative to n.
    if range <= (1 << 22) && range <= n.saturating_mul(2) {
        let mut h0 = vec![0u32; range];
        let mut h1 = vec![0u32; range];
        let mut h2 = vec![0u32; range];
        let mut h3 = vec![0u32; range];
        let mut chunks = v.chunks_exact(4);
        for c in &mut chunks {
            h0[(c[0] - mn) as usize] += 1;
            h1[(c[1] - mn) as usize] += 1;
            h2[(c[2] - mn) as usize] += 1;
            h3[(c[3] - mn) as usize] += 1;
        }
        for &x in chunks.remainder() {
            h0[(x - mn) as usize] += 1;
        }
        let mut pos = 0usize;
        for i in 0..range {
            let c = (h0[i] + h1[i] + h2[i] + h3[i]) as usize;
            if c != 0 {
                let val = mn + i as u32;
                v[pos..pos + c].fill(val);
                pos += c;
            }
        }
        debug_assert_eq!(pos, n);
        return;
    }
    // Fallback: LSD radix sort, 3 passes of 11 bits (stable, exact).
    let mut buf = vec![0u32; n];
    let mut src: &mut [u32] = &mut v[..];
    let mut dst: &mut [u32] = &mut buf[..];
    for pass in 0..3 {
        let sh = pass * 11;
        let mut cnt = [0usize; 2048];
        for &x in src.iter() {
            cnt[((x >> sh) & 2047) as usize] += 1;
        }
        let mut s = 0;
        for c in cnt.iter_mut() {
            let t = *c;
            *c = s;
            s += t;
        }
        for &x in src.iter() {
            let b = ((x >> sh) & 2047) as usize;
            dst[cnt[b]] = x;
            cnt[b] += 1;
        }
        std::mem::swap(&mut src, &mut dst);
    }
    // 3 passes (odd) => result lives in buf
    src_copy(v, &buf);
}

fn src_copy(v: &mut Vec<u32>, buf: &[u32]) {
    v.copy_from_slice(buf);
}
