set -e
cd "$(dirname "$0")"
cat > /tmp/p3_vis_$$.rs <<'R'
#[path = "PLACEHOLDER/solution.rs"] mod solution;
fn main() {
  use solution::max_sliding_window as f;
  assert_eq!(f(&[1,3,-1,-3,5,3,6,7],3), vec![3,3,5,5,6,7]);
  assert_eq!(f(&[1],1), vec![1]);
  assert_eq!(f(&[],1), Vec::<i32>::new());
  assert_eq!(f(&[9,8,7],3), vec![9]);
  assert_eq!(f(&[i32::MIN, i32::MAX, 0],1), vec![i32::MIN, i32::MAX, 0]);
  println!("visible tests passed");
}
R
sed -i "s#PLACEHOLDER#$PWD#" /tmp/p3_vis_$$.rs
rustc -O -o /tmp/p3_vis_$$ /tmp/p3_vis_$$.rs && /tmp/p3_vis_$$
