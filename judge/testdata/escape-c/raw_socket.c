// Expected: raw sockets are refused; exit 3 if one is created.
#include <sys/socket.h>
#include <netinet/in.h>
int main(void) { return socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) >= 0 ? 3 : 0; }
