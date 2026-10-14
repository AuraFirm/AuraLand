// Expected: none of the host's secrets are visible; exit 3 if any can be opened.
#include <fcntl.h>
#include <unistd.h>
int main(void) {
    const char *paths[] = {"/etc/shadow", "/root", "/proc/1/environ", "/var/local/lib/isolate", "/sys/fs/cgroup/cgroup.procs"};
    for (int i = 0; i < 5; i++) if (open(paths[i], O_RDONLY) >= 0) return 3;
    return 0;
}
