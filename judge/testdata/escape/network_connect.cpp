// Expected: no network; exit 3 if a connection to anything succeeds.
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
int main() {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(53); inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
    return connect(fd, (sockaddr *)&a, sizeof a) == 0 ? 3 : 0;
}
