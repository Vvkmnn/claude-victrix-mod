import java.nio.file.*; import java.util.*; import java.util.regex.*;
public class Bench {
  static final Pattern P = Pattern.compile("[A-Z]{3}-[0-9]{6}");
  static long regexPre(String[] a){ long n=0; for(String s:a) if(P.matcher(s).matches()) n++; return n; }
  static long manual(String[] a){ long n=0; for(String s:a){ if(s.length()!=10) continue; char c0=s.charAt(0),c1=s.charAt(1),c2=s.charAt(2); if(c0<'A'||c0>'Z'||c1<'A'||c1>'Z'||c2<'A'||c2>'Z'||s.charAt(3)!='-') continue; boolean ok=true; for(int i=4;i<10;i++){char c=s.charAt(i); if(c<'0'||c>'9'){ok=false;break;}} if(ok) n++; } return n; }
  interface F { long f(String[] a); }
  static boolean check(F f){ Random r=new Random(5); String alpha="AZaz09-_\n é٣Ａ😀"; 
    String[] fixed={"ABC-123456","ABC-123456\n","ABC-12345","ABCD-123456","ABC-1234567","abc-123456","ABC-12345٣","ＡBC-123456","AB😀-12345","","ZZZ-000000","AAA-999999","A C-123456"};
    if(f.f(fixed)!=regexPre(fixed)) return false;
    for(int t=0;t<20000;t++){ int n=r.nextInt(14); StringBuilder b=new StringBuilder(); String base="ABC-123456"; for(int i=0;i<n;i++) b.append(r.nextInt(3)==0? alpha.charAt(r.nextInt(alpha.length())) : (i<10? base.charAt(i):'1')); String[] one={b.toString()}; if(f.f(one)!=regexPre(one)) return false; }
    return true; }
  static double time(F f, String[] a){ for(int i=0;i<15;i++) f.f(a); double best=1e18; for(int i=0;i<15;i++){ long t=System.nanoTime(); long r=f.f(a); double d=(System.nanoTime()-t)/1e6; if(d<best)best=d; if(r<0) System.out.print(""); } return best; }
  public static void main(String[] x) throws Exception {
    String[] a = Files.readAllLines(Path.of("/home/claude/v2/base/q6/data/ids.txt")).toArray(new String[0]);
    System.out.printf("%9.1f ms  ref: precompiled Pattern%n", time(Bench::regexPre,a));
    System.out.printf("%9.1f ms  ref: manual char checks%n", time(Bench::manual,a));
    F s = Solution::countValid; System.out.println(check(s) ? String.format("%9.1f ms  SOLUTION (count=%d)", time(s,a), s.f(a)) : "SOLUTION WRONG");
  } }
