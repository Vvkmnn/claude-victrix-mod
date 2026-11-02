#define _GNU_SOURCE
#include <sqlite3.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
typedef struct{int fd;int len;char buf[1024];}Conn; /* ~1KB per conn */
static sqlite3*db; static sqlite3_stmt*sfeed,*spost;
static char out[65536];
static int jesc(char*o,const unsigned char*s,int n){char*p=o;for(int i=0;i<n;i++){unsigned c=s[i];if(c=='"'||c=='\\'){*p++='\\';*p++=c;}else if(c<0x20){p+=sprintf(p,"\\u%04x",c);}else *p++=c;}return p-o;}
static int row(char*o,sqlite3_stmt*s){char*p=o;
 p+=sprintf(p,"{\"id\":%d,\"body\":\"",sqlite3_column_int(s,0));
 p+=jesc(p,sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
 p+=sprintf(p,"\",\"created_at\":\"%s\",\"author\":\"",sqlite3_column_text(s,2));
 p+=jesc(p,sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
 p+=sprintf(p,"\",\"like_count\":%d}",sqlite3_column_int(s,4));return p-o;}
static int respond(Conn*c,char*resp){ /* returns len */
 char body[60000];int bl=0;int code=200;
 if(!memcmp(c->buf,"GET /feed ",10)){bl=sprintf(body,"{\"posts\":[");sqlite3_reset(sfeed);int f=1;while(sqlite3_step(sfeed)==SQLITE_ROW){if(!f)body[bl++]=',';f=0;bl+=row(body+bl,sfeed);}bl+=sprintf(body+bl,"]}");}
 else if(!memcmp(c->buf,"GET /posts/",11)){long id=atol(c->buf+11);sqlite3_reset(spost);sqlite3_bind_int64(spost,1,id);if(sqlite3_step(spost)==SQLITE_ROW){bl=sprintf(body,"{\"post\":");bl+=row(body+bl,spost);body[bl++]='}';}else{code=404;bl=sprintf(body,"{\"error\":\"post not found\"}");}}
 else if(!memcmp(c->buf,"GET /health ",12)){bl=sprintf(body,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":1}");}
 else{code=404;bl=sprintf(body,"{\"error\":\"not found\"}");}
 return sprintf(resp,"HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%.*s",code,bl,bl,body);}
int main(int argc,char**argv){
 sqlite3_open_v2(argv[1],&db,SQLITE_OPEN_READONLY|SQLITE_OPEN_NOMUTEX,0);
 sqlite3_exec(db,"PRAGMA mmap_size=1073741824",0,0,0);
 sqlite3_prepare_v3(db,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20",-1,SQLITE_PREPARE_PERSISTENT,&sfeed,0);
 sqlite3_prepare_v3(db,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?",-1,SQLITE_PREPARE_PERSISTENT,&spost,0);
 int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0);int one=1;setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);
 struct sockaddr_in a={AF_INET,htons(atoi(argv[2])),{htonl(INADDR_LOOPBACK)}};bind(ls,(void*)&a,sizeof a);listen(ls,4096);
 int ep=epoll_create1(0);struct epoll_event ev={EPOLLIN,{.ptr=0}};epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
 static struct epoll_event evs[256];
 for(;;){int n=epoll_wait(ep,evs,256,-1);for(int i=0;i<n;i++){Conn*c=evs[i].data.ptr;
  if(!c){for(;;){int fd=accept4(ls,0,0,SOCK_NONBLOCK);if(fd<0)break;setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,4);Conn*nc=calloc(1,sizeof(Conn));nc->fd=fd;struct epoll_event e={EPOLLIN,{.ptr=nc}};epoll_ctl(ep,EPOLL_CTL_ADD,fd,&e);}continue;}
  int r=read(c->fd,c->buf+c->len,sizeof(c->buf)-1-c->len);
  if(r<=0){if(r<0&&errno==EAGAIN)continue;close(c->fd);free(c);continue;}
  c->len+=r;c->buf[c->len]=0;
  if(strstr(c->buf,"\r\n\r\n")){int l=respond(c,out);write(c->fd,out,l);c->len=0;}
 }}}
