// prototype: single-thread epoll HTTP server, GET /feed and /posts/:id only
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/resource.h>
static sqlite3*db; static sqlite3_stmt *sfeed,*spost,*slk,*scnt; static int mode;
static char body[65536], resp[70000];
static int esc(char*o,const unsigned char*b,int n){int k=0;for(int i=0;i<n;i++){unsigned char c=b[i];if(c=='"'||c=='\\'){o[k++]='\\';o[k++]=c;}else if(c<32){k+=sprintf(o+k,"\\u%04x",c);}else o[k++]=c;}return k;}
static int itoa_(char*o,long v){char t[24];int n=0;if(!v)t[n++]='0';while(v){t[n++]='0'+v%10;v/=10;}int k=0;while(n)o[k++]=t[--n];return k;}
#define LIT(s) (memcpy(p,s,sizeof(s)-1),p+=sizeof(s)-1)
static int render_row(char*p0,sqlite3_stmt*s,int likes){char*p=p0;LIT("{\"id\":");p+=itoa_(p,sqlite3_column_int64(s,0));LIT(",\"body\":\"");p+=esc(p,sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));LIT("\",\"created_at\":\"");int l=sqlite3_column_bytes(s,2);memcpy(p,sqlite3_column_text(s,2),l);p+=l;LIT("\",\"author\":\"");p+=esc(p,sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));LIT("\",\"like_count\":");p+=itoa_(p,likes);*p++='}';return p-p0;}
static int do_feed(){char*p=body;LIT("{\"posts\":[");int n=0;long ids[20];int lk[20];
 if(mode==0){while(sqlite3_step(sfeed)==SQLITE_ROW){if(n)*p++=',';p+=render_row(p,sfeed,sqlite3_column_int(sfeed,4));n++;}sqlite3_reset(sfeed);}
 else{ // two-phase: rows w/o counts, then one range scan over likes_post_id_idx
  char*starts[20];int lens[20];char tmp[20][700];long lo=1L<<60,hi=0;
  while(sqlite3_step(sfeed)==SQLITE_ROW&&n<20){ids[n]=sqlite3_column_int64(sfeed,0);if(ids[n]<lo)lo=ids[n];if(ids[n]>hi)hi=ids[n];lens[n]=render_row(tmp[n],sfeed,0);n++;}
  sqlite3_reset(sfeed);
  if(hi-lo<=256){ int cnt[257]={0}; sqlite3_bind_int64(scnt,1,lo);sqlite3_bind_int64(scnt,2,hi);while(sqlite3_step(scnt)==SQLITE_ROW)cnt[sqlite3_column_int64(scnt,0)-lo]++;sqlite3_reset(scnt);for(int i=0;i<n;i++)lk[i]=cnt[ids[i]-lo];}
  else return -1;
  for(int i=0;i<n;i++){if(i)*p++=',';char*q=tmp[i];int l=lens[i];char*e=q+l-1;/* strip trailing '}' and the 0 */ char*c=e;while(*c!=':')c--; /* like_count value is "0}" */ int pre=c+1-q; memcpy(p,q,pre);p+=pre;p+=itoa_(p,lk[i]);*p++='}';}
 }
 LIT("]}");return p-body;}
static int do_post(long id){sqlite3_bind_int64(spost,1,id);int r=sqlite3_step(spost);if(r!=SQLITE_ROW){sqlite3_reset(spost);return -1;}char*p=body;LIT("{\"post\":");p+=render_row(p,spost,sqlite3_column_int(spost,4));*p++='}';sqlite3_reset(spost);return p-body;}
static void handle(int fd,char*req,int n){int bl;
 if(!memcmp(req,"GET /feed",9)){bl=do_feed();}
 else if(!memcmp(req,"GET /posts/",11)){bl=do_post(atol(req+11));}
 else bl=-1;
 int hl=0; if(bl<0){bl=0;} hl=sprintf(resp,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n",bl);memcpy(resp+hl,body,bl);
 write(fd,resp,hl+bl);}
int main(int argc,char**argv){
 mode=atoi(argv[2]);int port=atoi(argv[3]);
 sqlite3_config(SQLITE_CONFIG_SINGLETHREAD);sqlite3_config(SQLITE_CONFIG_MEMSTATUS,0);
 sqlite3_open_v2(argv[1],&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0);sqlite3_exec(db,"PRAGMA mmap_size=1000000000;PRAGMA cache_size=-32768",0,0,0);
 const char*base="SELECT p.id,p.body,p.created_at,u.username,%s FROM posts p JOIN users u ON u.id=p.user_id ";
 char q[1000];
 sprintf(q,base,mode==0?"(SELECT count(*) FROM likes l WHERE l.post_id=p.id)":"0");strcat(q,"ORDER BY p.created_at DESC,p.id DESC LIMIT 20");sqlite3_prepare_v2(db,q,-1,&sfeed,0);
 sprintf(q,base,"(SELECT count(*) FROM likes l WHERE l.post_id=p.id)");strcat(q,"WHERE p.id=?");sqlite3_prepare_v2(db,q,-1,&spost,0);
 sqlite3_prepare_v2(db,"SELECT post_id FROM likes WHERE post_id BETWEEN ? AND ?",-1,&scnt,0);
 struct rlimit rl={65535,65535};setrlimit(RLIMIT_NOFILE,&rl);
 int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0);int one=1;setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);struct sockaddr_in a={0};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);a.sin_port=htons(port);bind(ls,(void*)&a,sizeof a);listen(ls,4096);
 int ep=epoll_create1(0);struct epoll_event ev={.events=EPOLLIN,.data.fd=ls};epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
 struct epoll_event evs[256];char buf[4096];
 for(;;){int n=epoll_wait(ep,evs,256,-1);for(int i=0;i<n;i++){int fd=evs[i].data.fd;
  if(fd==ls){for(;;){int c=accept4(ls,0,0,SOCK_NONBLOCK);if(c<0)break;setsockopt(c,IPPROTO_TCP,TCP_NODELAY,&one,4);struct epoll_event e={.events=EPOLLIN,.data.fd=c};epoll_ctl(ep,EPOLL_CTL_ADD,c,&e);}}
  else{int r=read(fd,buf,sizeof buf);if(r<=0){close(fd);continue;}buf[r]=0;handle(fd,buf,r);}}}
}
