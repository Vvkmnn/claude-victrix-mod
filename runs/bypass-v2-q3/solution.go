package main

import "sync"

// parse returns the number for "u"+7 digits, or -1 if q is not of that shape.
func parse(q string) int {
	if len(q) != 8 || q[0] != 'u' {
		return -1
	}
	n := 0
	for i := 1; i < 8; i++ {
		d := int(q[i]) - '0'
		if uint(d) > 9 {
			return -1
		}
		n = n*10 + d
	}
	return n
}

func lookupMap(keys []string, vals []int64, queries []string) []int64 {
	m := make(map[string]int64, len(keys))
	for i, k := range keys {
		m[k] = vals[i]
	}
	out := make([]int64, len(queries))
	for i, q := range queries {
		if v, ok := m[q]; ok {
			out[i] = v
		} else {
			out[i] = -1
		}
	}
	return out
}

func Lookup(keys []string, vals []int64, queries []string) []int64 {
	// Fast path: every key is "u"+7 digits and the id range is compact.
	// Guard: otherwise fall back to the general map.
	maxK := -1
	nums := make([]int32, len(keys))
	for i, k := range keys {
		n := parse(k)
		if n < 0 {
			return lookupMap(keys, vals, queries)
		}
		nums[i] = int32(n)
		if n > maxK {
			maxK = n
		}
	}
	if maxK >= 4*len(keys)+1024 {
		return lookupMap(keys, vals, queries)
	}
	tab := make([]int64, maxK+1)
	for i := range tab {
		tab[i] = -1
	}
	for i, n := range nums {
		tab[n] = vals[i]
	}
	out := make([]int64, len(queries))
	work := func(lo, hi int) {
		var idx [1024]int32
		for b := lo; b < hi; b += len(idx) {
			e := b + len(idx)
			if e > hi {
				e = hi
			}
			// phase 1: parse (sequential reads); phase 2: gather (independent misses)
			for i := b; i < e; i++ {
				n := parse(queries[i])
				if n < 0 || n > maxK {
					n = -1
				}
				idx[i-b] = int32(n)
			}
			for i := b; i < e; i++ {
				if n := idx[i-b]; n >= 0 {
					out[i] = tab[n]
				} else {
					out[i] = -1
				}
			}
		}
	}
	const par = 4
	if len(queries) < 100000 {
		work(0, len(queries))
		return out
	}
	var wg sync.WaitGroup
	step := (len(queries) + par - 1) / par
	for lo := 0; lo < len(queries); lo += step {
		hi := lo + step
		if hi > len(queries) {
			hi = len(queries)
		}
		wg.Add(1)
		go func(lo, hi int) { defer wg.Done(); work(lo, hi) }(lo, hi)
	}
	wg.Wait()
	return out
}
