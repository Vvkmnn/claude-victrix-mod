#include <stddef.h>
static const char *skip_header(const char *p, const char *e){ while(p<e && *p!='\n') p++; return p<e? p+1 : e; }
long long ref_scan(const char *buf, size_t len){ const char *p=skip_header(buf,buf+len), *e=buf+len; unsigned long long t=0;
  while(p<e){ while(p<e && *p!=',') p++; p++; while(p<e && *p!=',') p++; p++; unsigned long long q=0,r=0; while(p<e && *p!=',') q=q*10+(*p++-'0'); p++; while(p<e && *p!='\n') r=r*10+(*p++-'0'); p++; t+=q*r; } return (long long)t; }
long long ref_fixed(const char *buf, size_t len){ const char *p=skip_header(buf,buf+len), *e=buf+len; unsigned long long t=0;
  while(p<e){ if(e-p>=34 && p[8]==',' && p[19]==',' && p[26]==',' && p[33]=='\n'){ const char *a=p+20,*b=p+27; unsigned q=(a[0]-'0')*100000+(a[1]-'0')*10000+(a[2]-'0')*1000+(a[3]-'0')*100+(a[4]-'0')*10+(a[5]-'0'); unsigned r=(b[0]-'0')*100000+(b[1]-'0')*10000+(b[2]-'0')*1000+(b[3]-'0')*100+(b[4]-'0')*10+(b[5]-'0'); t+=(unsigned long long)q*r; p+=34; }
    else { while(p<e && *p!=',') p++; p++; while(p<e && *p!=',') p++; p++; unsigned long long q=0,r=0; while(p<e && *p!=',') q=q*10+(*p++-'0'); p++; while(p<e && *p!='\n') r=r*10+(*p++-'0'); p++; t+=q*r; } } return (long long)t; }
