package main

func Lookup(keys []string, vals []int64, queries []string) []int64 {
	m := make(map[string]int64)
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
