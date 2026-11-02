package main

import "testing"

func TestVisible(t *testing.T) {
	got := Lookup([]string{"u0000000", "u0000001", "x"}, []int64{5, 6, 7}, []string{"u0000001", "nope", "x", "u0000000"})
	want := []int64{6, -1, 7, 5}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}
