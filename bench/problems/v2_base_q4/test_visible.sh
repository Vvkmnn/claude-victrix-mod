set -e
cd "$(dirname "$0")"
T="${TMPDIR:-/tmp}"
cat > "$T/q4_vis.rs" <<R
#[path = "$PWD/solution.rs"] mod solution;
fn main() {
  let mut a = vec![3u32, 1, 2, 3, 0]; solution::sort_values(&mut a); assert_eq!(a, vec![0, 1, 2, 3, 3]);
  let mut b: Vec<u32> = vec![]; solution::sort_values(&mut b); assert!(b.is_empty());
  let mut c = vec![u32::MAX, 0, 7]; solution::sort_values(&mut c); assert_eq!(c, vec![0, 7, u32::MAX]);
  println!("visible tests passed");
}
R
rustc -O -o "$T/q4_vis" "$T/q4_vis.rs" && "$T/q4_vis"
