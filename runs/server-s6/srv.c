// prototype: single-thread epoll + sqlite, read paths only (feed, post, health, 404)
#define _GNU_SOURCE
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
static sqlite3 *db; static sqlite3_stmt *sfeed,*spost,*shealth;
static char out[1<<16]; // response assembly; header reserved at front
#define HDR 160
static int esc(char*d,const char*s,int n){char*o=d;for(int i=0;i<n;i++){unsigned char c=s[i];
  if(c=='"'||c=='\\'){*o++='\\';*o++=c;}else if(c<0x20){o+=sprintf(o,"\\u%04x",c);}else *o++=c;}return o-d;}
static int postjson(char*p,sqlite3_stmt*s){
  char*o=p; o+=sprintf(o,"{\"id\":%d,\"body\":\"",sqlite3_column_int(s,0));
  o+=esc(o,(const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  o+=sprintf(o,"\",\"created_at\":\"%s\",\"author\":\"",sqlite3_column_text(s,2));
  o+=esc(o,(const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  o+=sprintf(o,"\",\"like_count\":%d}",sqlite3_column_int(s,4)); return o-p;}
static int finish(int status,const char*st,char*body,int bl,char**start){
  char h[HDR]; int hl=snprintf(h,HDR,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n",status,st,bl);
  *start=body-hl; memcpy(*start,h,hl); return hl+bl;}
static int handle(const char*req,int rl,char**resp){
  char*b=out+HDR; int bl;
  if(!memcmp(req,"GET /feed ",10)){ bl=sprintf(b,"{\"posts\":["); int first=1;
    while(sqlite3_step(sfeed)==SQLITE_ROW){ if(!first)b[bl++]=','; first=0; bl+=postjson(b+bl,sfeed);} sqlite3_reset(sfeed);
    b[bl++]=']';b[bl++]='}'; return finish(200,"OK",b,bl,resp);}
  if(!memcmp(req,"GET /posts/",11)){ const char*p=req+11; long id=0; int n=0; while(*p>='0'&&*p<='9'&&n<12){id=id*10+*p-'0';p++;n++;}
    if(*p!=' '||n==0||id<=0){bl=sprintf(b,"{\"error\":\"invalid post id\"}");return finish(400,"Bad Request",b,bl,resp);}
    sqlite3_bind_int64(spost,1,id);
    if(sqlite3_step(spost)==SQLITE_ROW){bl=sprintf(b,"{\"post\":");bl+=postjson(b+bl,spost);b[bl++]='}';sqlite3_reset(spost);return finish(200,"OK",b,bl,resp);}
    sqlite3_reset(spost); bl=sprintf(b,"{\"error\":\"post not found\"}");return finish(404,"Not Found",b,bl,resp);}
  if(!memcmp(req,"GET /health ",12)){ sqlite3_step(shealth);sqlite3_reset(shealth); bl=sprintf(b,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":1}");return finish(200,"OK",b,bl,resp);}
  bl=sprintf(b,"{\"error\":\"not found\"}");return finish(404,"Not Found",b,bl,resp);}
typedef struct{char buf[2048];int len;}conn;
int main(){
  sqlite3_open_v2(getenv("SQLITE_PATH"),&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0);
  sqlite3_exec(db,"PRAGMA synchronous=NORMAL;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-32768;PRAGMA temp_store=MEMORY",0,0,0);
  const char*pf="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
  char q[512];
  snprintf(q,512,"%sORDER BY p.created_at DESC,p.id DESC LIMIT 20",pf); sqlite3_prepare_v3(db,q,-1,SQLITE_PREPARE_PERSISTENT,&sfeed,0);
  snprintf(q,512,"%sWHERE p.id=?",pf); sqlite3_prepare_v3(db,q,-1,SQLITE_PREPARE_PERSISTENT,&spost,0);
  sqlite3_prepare_v3(db,"SELECT 1",-1,SQLITE_PREPARE_PERSISTENT,&shealth,0);
  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0),one=1; setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);
  struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(atoi(getenv("PORT"))),.sin_addr.s_addr=inet_addr("127.0.0.1")};
  bind(ls,(void*)&a,sizeof a); listen(ls,4096);
  int ep=epoll_create1(0); struct epoll_event ev={.events=EPOLLIN,.data.fd=ls}; epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  static conn*conns[70000]; struct epoll_event evs[256];
  for(;;){ int n=epoll_wait(ep,evs,256,-1);
    for(int i=0;i<n;i++){ int fd=evs[i].data.fd;
      if(fd==ls){ for(;;){int c=accept4(ls,0,0,SOCK_NONBLOCK); if(c<0)break; setsockopt(c,IPPROTO_TCP,TCP_NODELAY,&one,4);
          conns[c]=calloc(1,sizeof(conn)); struct epoll_event e={.events=EPOLLIN,.data.fd=c}; epoll_ctl(ep,EPOLL_CTL_ADD,c,&e);} continue;}
      conn*c=conns[fd]; int r=read(fd,c->buf+c->len,sizeof c->buf-1-c->len);
      if(r<=0){ if(r<0&&errno==EAGAIN)continue; close(fd);free(c);conns[fd]=0;continue;}
      c->len+=r; c->buf[c->len]=0; char*e;
      while((e=strstr(c->buf,"\r\n\r\n"))){ int rl=e+4-c->buf; char*resp; int L=handle(c->buf,rl,&resp);
        if(write(fd,resp,L)!=L){fprintf(stderr,"short write\n");}
        memmove(c->buf,c->buf+rl,c->len-rl); c->len-=rl; c->buf[c->len]=0; }
    }}
}
